import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { createPool } from '../db/index';

/**
 * THE DOCUMENT STORE — one datastore, on PostgreSQL.
 *
 * WHAT WAS WRONG
 * --------------
 * This system had two datastores and could not say which one held the truth.
 *
 *   - The producer wrote PostgreSQL. `inboundPipeline` inserted conversations and messages
 *     through Drizzle; `privacy.service` and `suppression.service` updated contacts there.
 *   - The consumer read Firestore. `outbox.service` queued, claimed and drained jobs there;
 *     `identityStore`, `factStore`, `circuitBreaker` and the action gateway all read there.
 *
 * So the stop rules and the queue they were meant to stop were in different databases. Every
 * suppression check, every campaign guard and every version fence in this repository sat on
 * one side of that split and enforced against the other. That is the defect S26 and S48 name,
 * and it is why both stayed PARTIAL: the guards were real, and they were reading a store the
 * send path did not write.
 *
 * Worse, the Firestore half was not reachable at all without an exposure. `server/firebase.ts`
 * connected with the CLIENT SDK, unauthenticated, with a comment recording why: "to bypass IAM
 * limits". Security rules apply to the client SDK, so `firestore.rules` could never be
 * tightened without denying the server itself — which is precisely why `allow read, write: if
 * true` was still live, with the API key committed to a public repository. The workaround and
 * the exposure were the same fact seen from two sides.
 *
 * WHAT THIS IS
 * ------------
 * A document store with the same shape the call sites already use — collections, documents,
 * equality queries, transactions — implemented over the PostgreSQL instance this system
 * already runs, verified, over a pinned TLS connection (`server/db/tls.ts`).
 *
 * It is a DOCUMENT store, not a normalisation. The twenty relational tables in
 * `server/db/schema.ts` still exist and still hold what they hold; this does not fold the
 * document collections into them. That per-entity migration is a separate job and is stated as
 * outstanding rather than implied to be done — writing a shim and calling the schema unified
 * would be the same unchecked completion claim this codebase's audit exists to catch.
 *
 * What it does settle, today, is the question the split made unanswerable: there is now ONE
 * database, ONE transaction manager, and one place a write can be seen from.
 *
 * HOW IT DIFFERS FROM WHAT IT REPLACES — read this before assuming behaviour carried over
 * ---------------------------------------------------------------------------------------
 *  1. TRANSACTIONS ARE SERIALIZABLE, not optimistic. Firestore aborted a transaction if a
 *     document it had READ changed before commit. PostgreSQL SERIALIZABLE detects the same
 *     conflicts through SSI and aborts the same way, so `mutateWithVersion` and the outbox
 *     claim keep their meaning. Retries on 40001/40P01 are handled here, as Firestore handled
 *     its own.
 *
 *  2. A TRANSACTION SEES ITS OWN WRITES. Firestore buffered writes until commit, so `tx.get`
 *     after `tx.set` returned the OLD value. Here it returns the new one. No call site in this
 *     repository reads a document after writing it in the same transaction — checked, not
 *     assumed — but new code must not rely on the old behaviour, and there is a test that
 *     pins this difference so it is discovered by a failing test rather than in production.
 *
 *  3. READS NEED NOT PRECEDE WRITES. Firestore required it. PostgreSQL does not.
 *
 *  4. `undefined` IS REFUSED, not stripped. This matches what the client SDK did (it throws
 *     unless `ignoreUndefinedProperties` is set, and it was not), so the behaviour is
 *     preserved rather than quietly relaxed. `JSON.stringify` would have dropped the field
 *     silently, which is how a required value goes missing without an error.
 */

type Executor = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** The store handle. `null` when no database is configured, mirroring the old export. */
export interface DocumentStore {
  readonly pool: pg.Pool;
}

export interface CollectionReference {
  readonly kind: 'collection';
  /** Slash-joined path with an ODD number of segments, e.g. `organizations/acme/contacts`. */
  readonly path: string;
}

export interface DocumentReference {
  readonly kind: 'document';
  /** The path of the collection this document lives in. */
  readonly path: string;
  readonly id: string;
}

export interface DocumentSnapshot<T = Record<string, unknown>> {
  readonly id: string;
  readonly ref: DocumentReference;
  exists(): boolean;
  data(): T | undefined;
}

/**
 * A row a query returned. It exists by construction, so `data()` is `T`, not `T | undefined`.
 *
 * One snapshot type used to serve both `getDoc` and query rows, so every
 * `snap.forEach(d => d.data().x)` read a possibly-undefined value: twelve strictNullChecks errors,
 * each at a call site where the row could not be absent. Firestore drew the same distinction.
 */
export interface QueryDocumentSnapshot<T = Record<string, unknown>> extends DocumentSnapshot<T> {
  data(): T;
}

export interface QuerySnapshot<T = Record<string, unknown>> {
  readonly docs: QueryDocumentSnapshot<T>[];
  readonly size: number;
  readonly empty: boolean;
  forEach(fn: (doc: QueryDocumentSnapshot<T>) => void): void;
}

/** A filter, an ordering or a row cap. Built by `where`, `orderBy` and `limit`. */
export type QueryConstraint =
  | { readonly kind: 'where'; readonly field: string; readonly value: unknown }
  | { readonly kind: 'orderBy'; readonly field: string; readonly direction: 'asc' | 'desc' }
  | { readonly kind: 'limit'; readonly count: number };

export interface StoreQuery {
  readonly kind: 'query';
  readonly collectionPath: string;
  readonly constraints: readonly QueryConstraint[];
}

export class StorePathError extends Error {
  readonly code = 'STORE_PATH_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'StorePathError';
  }
}

export class StoreValueError extends Error {
  readonly code = 'STORE_VALUE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'StoreValueError';
  }
}

/**
 * The last line of defence on path shape.
 *
 * `orgPath()` already validates every segment it is given, but it is not the only way a path
 * reaches this module — `factsPath` builds one, and `server.ts` interpolates collection names
 * from route parameters. A path that splits differently than intended silently retargets a
 * read at another tenant's data, so the check lives here too, where it cannot be bypassed by
 * calling a different builder.
 */
function assertCollectionPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new StorePathError(
      `Collection path must be a non-empty string; received ${JSON.stringify(path)}.`
    );
  }
  const segments = path.split('/');
  if (segments.length % 2 !== 1) {
    throw new StorePathError(
      `Collection path ${JSON.stringify(path)} has ${segments.length} segments. A collection ` +
        'path alternates collection/document and must have an odd number.'
    );
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new StorePathError(
        `Path ${JSON.stringify(path)} contains the segment ${JSON.stringify(segment)}, which ` +
          'would change the shape of the path.'
      );
    }
  }
  return path;
}

function assertDocumentId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new StorePathError(
      `Document id must be a non-empty string; received ${JSON.stringify(id)}.`
    );
  }
  if (id.includes('/') || id === '.' || id === '..') {
    throw new StorePathError(
      `Document id ${JSON.stringify(id)} would change the shape of the path.`
    );
  }
  return id;
}

/**
 * The tenant this path belongs to, stored as its own column.
 *
 * Derived rather than passed, so it cannot disagree with the path it is stored beside. It is a
 * column and not a prefix match because tenancy is the property most worth being able to state
 * in SQL: `SELECT ... WHERE org_id <> $1` is a question a test can ask of the real database,
 * and `LIKE 'organizations/acme/%'` is a question about string formatting.
 *
 * Top-level collections (`oauth_connections`, `organizations`, `system_settings`) have no
 * tenant and store NULL.
 */
export function tenantOf(path: string): string | null {
  const segments = path.split('/');
  if (segments.length >= 3 && segments[0] === 'organizations') return segments[1];
  return null;
}

/**
 * Reject `undefined` anywhere in a document, at any depth.
 *
 * The client SDK threw on this and the throw is worth keeping: `JSON.stringify` drops an
 * `undefined` field without a word, so the failure mode is a document that is missing a value
 * the writing code believed it had written. That is indistinguishable, later, from a value
 * that was never meant to be there.
 */
export function assertNoUndefined(value: unknown, trail: string): void {
  if (value === undefined) {
    throw new StoreValueError(
      `Document field ${trail} is undefined. Write null to mean "known to be absent", or omit ` +
        'the field entirely; undefined would be dropped silently.'
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoUndefined(item, `${trail}[${i}]`));
    return;
  }
  if (value instanceof Date) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefined(child, `${trail}.${key}`);
  }
}

function toStoredJson(data: unknown, what: string): string {
  assertNoUndefined(data, what);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new StoreValueError(`${what} must be an object; received ${JSON.stringify(data)}.`);
  }
  return JSON.stringify(data);
}

/**
 * `tenantOf`, `compileQuery` and `assertNoUndefined` are exported for the invariant suite.
 *
 * They are the load-bearing pure logic in this module — which tenant a path belongs to, what
 * SQL a query becomes, and what values are refusable — and CI has no database, so they are the
 * part of the store that can be proved in the test suite rather than only in
 * `scripts/store-verify.ts`. Exporting them means the assertions run the real functions instead
 * of a copy of their rules, which is the failure mode a guardrail self-check already ran into
 * once in this repository.
 */

let cachedStore: DocumentStore | null | undefined;

/**
 * The store handle, or null when no database is configured.
 *
 * Null rather than throwing, because every call site already branches on `if (!store) return
 * ...` — that shape was written for the Firestore handle and is preserved exactly, so the
 * swap does not silently change what an unconfigured deployment does.
 */
export function getStore(): DocumentStore | null {
  if (cachedStore === undefined) {
    const pool = createPool();
    cachedStore = pool ? { pool } : null;
  }
  return cachedStore;
}

/** Reset the memoised handle. Tests only. */
export function resetStoreForTests(): void {
  cachedStore = undefined;
}

export const store: DocumentStore | null = getStore();

export function collection(_store: DocumentStore | null, path: string): CollectionReference {
  return { kind: 'collection', path: assertCollectionPath(path) };
}

/**
 * A document reference, in the two forms the call sites use:
 *
 *   doc(store, 'organizations/acme/contacts', id)
 *   doc(collectionRef, id)
 *
 * Written variadically rather than as two overloads with a fixed arity because an earlier
 * version of this double took exactly two arguments, and every call passing three silently
 * addressed the wrong document — the tests all failed identically and read like broken code
 * rather than a broken double.
 */
export function doc(
  first: DocumentStore | null | CollectionReference,
  ...rest: unknown[]
): DocumentReference {
  if (first !== null && typeof first === 'object' && (first as CollectionReference).kind === 'collection') {
    const ref = first as CollectionReference;
    const id = rest.length > 0 ? rest[0] : uuidv4();
    return { kind: 'document', path: assertCollectionPath(ref.path), id: assertDocumentId(id) };
  }
  const [path, id] = rest;
  return {
    kind: 'document',
    path: assertCollectionPath(path),
    id: assertDocumentId(id),
  };
}

export function where(field: string, op: '==', value: unknown): QueryConstraint {
  if (op !== '==') {
    throw new StoreValueError(
      `Only '==' is supported by this store; received ${JSON.stringify(op)}. Every query in ` +
        'this repository is an equality match; add the operator here deliberately rather ' +
        'than discovering at runtime that it was ignored.'
    );
  }
  if (value === undefined) {
    throw new StoreValueError(
      `where(${JSON.stringify(field)}, '==', undefined) matches nothing and almost always ` +
        'means the value failed to load. State null explicitly if that is the intent.'
    );
  }
  return { kind: 'where', field, value };
}

export function orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): QueryConstraint {
  return { kind: 'orderBy', field, direction };
}

export function limit(count: number): QueryConstraint {
  if (!Number.isInteger(count) || count <= 0) {
    throw new StoreValueError(`limit() needs a positive integer; received ${JSON.stringify(count)}.`);
  }
  return { kind: 'limit', count };
}

export function query(
  source: CollectionReference | StoreQuery,
  ...constraints: QueryConstraint[]
): StoreQuery {
  const base =
    source.kind === 'query'
      ? { path: source.collectionPath, existing: source.constraints }
      : { path: source.path, existing: [] as readonly QueryConstraint[] };
  return {
    kind: 'query',
    collectionPath: assertCollectionPath(base.path),
    constraints: [...base.existing, ...constraints],
  };
}

function snapshotOf<T>(
  ref: DocumentReference,
  row: { data: unknown } | undefined
): DocumentSnapshot<T> {
  const present = row !== undefined;
  return {
    id: ref.id,
    ref,
    exists: () => present,
    data: () => (present ? (row!.data as T) : undefined),
  };
}

function required(handle: DocumentStore | null): DocumentStore {
  if (!handle) {
    throw new StoreValueError(
      'The document store is not configured. Callers must branch on a null store rather than ' +
        'reaching this.'
    );
  }
  return handle;
}

/** The setting the row-security policy on `documents` reads. See migration 0009 and S4. */
export const TENANT_SETTING = 'app.org_id';

/**
 * S4 — name the tenant to the database, on this connection, for this transaction.
 *
 * The policy on `documents` shows a connection only the rows of the tenant it has named and the
 * tenantless top-level documents, and refuses a write into any other tenant's rows. The name is
 * the tenant the PATH addresses — the same derivation the `org_id` column uses — so a statement
 * whose own predicate is defective, or a script that reaches this table another way, cannot
 * cross a tenant boundary: the database has not been told that tenant exists. A tenantless path
 * names the empty string, which matches no organisation.
 */
async function nameTenant(exec: Executor, path: string): Promise<void> {
  await exec.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [tenantOf(path) ?? '']);
}

/** One statement, in its own transaction, with the tenant named first. */
async function withTenant<T>(handle: DocumentStore, path: string, run: (exec: Executor) => Promise<T>): Promise<T> {
  const client = await handle.pool.connect();
  try {
    await client.query('BEGIN');
    await nameTenant(client, path);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The statement's own error is the one to report.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function readDoc<T>(exec: Executor, ref: DocumentReference): Promise<DocumentSnapshot<T>> {
  const result = await exec.query('SELECT data FROM documents WHERE path = $1 AND id = $2', [
    ref.path,
    ref.id,
  ]);
  return snapshotOf<T>(ref, result.rows[0]);
}

/** `{ merge: true }` keeps fields the write does not mention. Absent means replace. */
export interface SetOptions {
  readonly merge?: boolean;
}

/**
 * `setDoc` REPLACES the document unless `{ merge: true }` is given. The replace is what
 * `mutateWithVersion` depends on: a field removed by `produceNext` must genuinely be removed,
 * or a mutation cannot delete a value.
 *
 * MERGE HERE IS SHALLOW, AND FIRESTORE'S WAS DEEP. `data || EXCLUDED.data` replaces a nested
 * object wholesale where Firestore would have merged its keys. All three merging call sites
 * write top-level scalars plus one object (`resultDetails` on an action log) that is meant to
 * be replaced on each status transition — a deep merge would accumulate keys there from
 * earlier transitions, so shallow is not merely adequate but correct. Anything relying on the
 * deep behaviour must say so explicitly; a test pins this so the difference surfaces as a
 * failing assertion rather than as stale fields in an audit record.
 *
 * Unlike `updateDoc`, a merging set CREATES a document that is not there. That is Firestore's
 * behaviour and `draftIntegrity` relies on it: it stamps an inbound version onto a
 * conversation document that may not exist yet.
 */
async function writeDoc(
  exec: Executor,
  ref: DocumentReference,
  data: unknown,
  options?: SetOptions
): Promise<void> {
  const json = toStoredJson(data, `document ${ref.path}/${ref.id}`);
  const resolution =
    options?.merge === true
      ? 'data = documents.data || EXCLUDED.data'
      : 'data = EXCLUDED.data';
  await exec.query(
    `INSERT INTO documents (path, id, org_id, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now(), now())
     ON CONFLICT (path, id) DO UPDATE SET ${resolution}, updated_at = now()`,
    [ref.path, ref.id, tenantOf(ref.path), json]
  );
}

/**
 * `updateDoc` merges top-level fields and REQUIRES the document to exist — both matching the
 * Firestore call it replaces. An update that creates is `setDoc`; letting update create would
 * turn "the record I meant to amend has gone" into a fresh, half-populated record.
 */
async function patchDoc(exec: Executor, ref: DocumentReference, data: unknown): Promise<void> {
  const json = toStoredJson(data, `update to ${ref.path}/${ref.id}`);
  const result = await exec.query(
    `UPDATE documents SET data = data || $3::jsonb, updated_at = now()
     WHERE path = $1 AND id = $2`,
    [ref.path, ref.id, json]
  );
  if (result.rowCount === 0) {
    throw new StoreValueError(
      `No document at ${ref.path}/${ref.id} to update. updateDoc does not create; use setDoc ` +
        'if creating is intended.'
    );
  }
}

async function removeDoc(exec: Executor, ref: DocumentReference): Promise<void> {
  await exec.query('DELETE FROM documents WHERE path = $1 AND id = $2', [ref.path, ref.id]);
}

/**
 * Compile a query to SQL.
 *
 * Equality is `data->'field' = $n::jsonb` rather than `data->>'field' = $n`. The `->>` form
 * renders everything as text, so `true` and `"true"` compare equal and `1` matches `"1"`; the
 * `->` form compares JSON values and keeps the type. A document missing the field yields SQL
 * NULL and is excluded, which is what Firestore did.
 *
 * Field names are interpolated as PARAMETERS, never into the SQL text, so a field name reaching
 * this from a route parameter cannot become syntax.
 */
export function compileQuery(q: StoreQuery): { text: string; values: unknown[] } {
  const values: unknown[] = [q.collectionPath];
  const clauses: string[] = ['path = $1'];
  let order = 'ORDER BY id ASC';
  let cap = '';

  for (const constraint of q.constraints) {
    if (constraint.kind === 'where') {
      values.push(constraint.field);
      const fieldParam = `$${values.length}`;
      values.push(JSON.stringify(constraint.value ?? null));
      const valueParam = `$${values.length}`;
      clauses.push(`data -> ${fieldParam} = ${valueParam}::jsonb`);
    } else if (constraint.kind === 'orderBy') {
      values.push(constraint.field);
      const fieldParam = `$${values.length}`;
      // ISO-8601 strings sort chronologically as text, which is what every ordered field in
      // this repository is. A numeric field would sort lexically here; there is none today,
      // and a test pins that so adding one is caught rather than silently mis-ordered.
      order = `ORDER BY data ->> ${fieldParam} ${constraint.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, id ASC`;
    } else {
      values.push(constraint.count);
      cap = `LIMIT $${values.length}`;
    }
  }

  return {
    text: `SELECT id, data FROM documents WHERE ${clauses.join(' AND ')} ${order} ${cap}`.trim(),
    values,
  };
}

async function readDocs<T>(exec: Executor, q: StoreQuery): Promise<QuerySnapshot<T>> {
  const { text, values } = compileQuery(q);
  const result = await exec.query(text, values);
  const docs = result.rows.map(
    (row: { id: string; data: unknown }): QueryDocumentSnapshot<T> => ({
      id: row.id,
      ref: { kind: 'document', path: q.collectionPath, id: row.id },
      exists: () => true,
      data: () => row.data as T,
    })
  );
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (fn) => docs.forEach(fn),
  };
}

function asQuery(source: CollectionReference | StoreQuery): StoreQuery {
  return source.kind === 'query' ? source : { kind: 'query', collectionPath: source.path, constraints: [] };
}

export async function getDoc<T = Record<string, unknown>>(
  ref: DocumentReference
): Promise<DocumentSnapshot<T>> {
  return withTenant(required(getStore()), ref.path, (exec) => readDoc<T>(exec, ref));
}

export async function getDocs<T = Record<string, unknown>>(
  source: CollectionReference | StoreQuery
): Promise<QuerySnapshot<T>> {
  const q = asQuery(source);
  return withTenant(required(getStore()), q.collectionPath, (exec) => readDocs<T>(exec, q));
}

export async function setDoc(
  ref: DocumentReference,
  data: unknown,
  options?: SetOptions
): Promise<void> {
  return withTenant(required(getStore()), ref.path, (exec) => writeDoc(exec, ref, data, options));
}

export async function updateDoc(ref: DocumentReference, data: unknown): Promise<void> {
  return withTenant(required(getStore()), ref.path, (exec) => patchDoc(exec, ref, data));
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  return withTenant(required(getStore()), ref.path, (exec) => removeDoc(exec, ref));
}

export async function addDoc(
  ref: CollectionReference,
  data: unknown
): Promise<DocumentReference> {
  const target: DocumentReference = { kind: 'document', path: ref.path, id: uuidv4() };
  await withTenant(required(getStore()), target.path, (exec) => writeDoc(exec, target, data));
  return target;
}

/** The transaction handle handed to a `runTransaction` callback. */
export interface Transaction {
  get<T = Record<string, unknown>>(ref: DocumentReference): Promise<DocumentSnapshot<T>>;
  getAll<T = Record<string, unknown>>(q: CollectionReference | StoreQuery): Promise<QuerySnapshot<T>>;
  set(ref: DocumentReference, data: unknown, options?: SetOptions): Promise<void>;
  update(ref: DocumentReference, data: unknown): Promise<void>;
  delete(ref: DocumentReference): Promise<void>;
  /**
   * The underlying client, so a Drizzle statement can join this transaction rather than open a
   * second one. This is the whole point of having one database: a write to a relational table
   * and a write to a document collection can now commit or fail together.
   */
  readonly client: pg.PoolClient;
}

/** PostgreSQL says "retry me" with these two. Anything else is a real fault. */
const RETRYABLE = new Set(['40001', '40P01']);

/**
 * TEN, AND THE NUMBER WAS MEASURED RATHER THAN CHOSEN.
 *
 * This was five, and five is not enough. Run against the real database with eight concurrent
 * read-modify-writes on one document, roughly three of every eight ran out of attempts and
 * threw 40001 — the counter finished at six instead of eight. Over five repetitions: 14
 * failures out of 40 writers. At ten attempts, over the same five repetitions: zero.
 *
 * That is the guarantee `mutateWithVersion`, the outbox claim and the human-ownership lock are
 * all built on, and no unit test could have found it — a mock transaction has no contention to
 * lose to. It took PostgreSQL under real concurrency, which is why `scripts/store-verify.ts`
 * exists and why it is a script rather than a suite that skips when there is no database.
 *
 * A JITTERED BACKOFF WAS TRIED HERE AND REMOVED, because it did not do anything. Full jitter
 * between attempts is the standard advice for this shape of problem, so it was written first
 * and then measured, five repetitions per cell, counting transactions that exhausted their
 * attempts:
 *
 *      writers  attempts  jitter   failures / writers
 *          8        5       no          14 / 40
 *          8        5       yes         15 / 40
 *          8       10       no           0 / 40
 *          8       10       yes          0 / 40
 *         16       10       no          17 / 80
 *         16       10       yes         19 / 80
 *         24       10       no          25 / 120
 *         24       10       yes         25 / 120
 *
 * The attempt count is what carries it; the jitter is inside the noise at every level, and at
 * 16 writers the jittered runs were marginally worse. These transactions are short and conflict
 * at COMMIT, so spacing the retries out in time does not stop them colliding — it only delays
 * them. Machinery that cannot be shown to do anything is machinery no test can pin, so it is
 * gone rather than kept and excused.
 *
 * WHAT THIS DOES NOT FIX, STATED PLAINLY. At 16 and 24 concurrent writers on ONE document,
 * transactions still exhaust ten attempts — 25 of 120 at the top of that table. They THROW;
 * they do not silently lose the write, and the caller decides what to do. Retry tuning is the
 * wrong tool for that case anyway: the fix for heavy contention on a single row is not to hit
 * it from 24 places at once. Nothing in this system does — the outbox gives every job its own
 * row — but a future counter document would need a different design, not a bigger number here.
 */
const MAX_ATTEMPTS = 10;

/**
 * Run a callback inside one SERIALIZABLE transaction, retrying on serialization failure.
 *
 * The callback MUST be idempotent: it may run more than once. That was true of the Firestore
 * transaction it replaces and is true here for the same reason — a retry re-executes the whole
 * body, so a side effect inside it happens once per attempt, not once per commit.
 *
 * WHY OPTIMISTIC RATHER THAN `SELECT ... FOR UPDATE`. Locking on every `tx.get` would remove
 * the contention by making readers wait instead of abort. It would also impose a lock ordering
 * on every multi-document transaction in this codebase, and getting that ordering wrong
 * produces deadlocks rather than retries. The Firestore transaction being replaced was
 * optimistic, so this one is too: same shape, same reasoning at the call sites, no new global
 * rule introduced by a migration.
 */
export async function runTransaction<T>(
  handle: DocumentStore | null,
  body: (tx: Transaction) => Promise<T>
): Promise<T> {
  if (!handle) {
    throw new StoreValueError('The document store is not configured; no transaction to run.');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const client = await handle.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      // S4 — each operation names its tenant on this connection first; the setting is local to
      // the transaction, so a transaction spanning two tenants sees each only while it names it.
      const tx: Transaction = {
        client,
        get: (ref) => nameTenant(client, ref.path).then(() => readDoc(client, ref)),
        getAll: (q) => nameTenant(client, asQuery(q).collectionPath).then(() => readDocs(client, asQuery(q))),
        set: (ref, data, options) => nameTenant(client, ref.path).then(() => writeDoc(client, ref, data, options)),
        update: (ref, data) => nameTenant(client, ref.path).then(() => patchDoc(client, ref, data)),
        delete: (ref) => nameTenant(client, ref.path).then(() => removeDoc(client, ref)),
      };
      const result = await body(tx);
      await client.query('COMMIT');
      return result;
    } catch (error: any) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already gone; the rollback is implicit.
      }
      lastError = error;
      if (!RETRYABLE.has(error?.code) || attempt === MAX_ATTEMPTS) throw error;
    } finally {
      // Every exit runs this: a `return` from the try, a rethrow from the catch, or looping
      // round to the next attempt. A connection held across a retry is a connection the retry
      // itself cannot have, which turns contention into a stall.
      client.release();
    }
  }
  throw lastError;
}
