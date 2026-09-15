/**
 * An in-memory stand-in for `server/store` with the transactional semantics that the outbox and
 * kill-switch suites depend on: a query returns a SNAPSHOT, a transaction re-reads, and a hook
 * lets a test play the competing writer that commits between the two.
 *
 * One module, imported by every suite that needs it, so there is one owner of what "the store"
 * means in a test. Two suites carried their own copy of this before; a third would have been
 * the same second-owner shape the production code was being cured of.
 *
 * Not the chaos suite's double: that one also aborts a transaction whose read changed before
 * commit, which is the mechanism chaos tests. This one models the ordering only.
 *
 * Use:
 *
 *     vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);
 *     import { memory } from './helpers/memoryDocumentStore';
 *     beforeEach(() => memory.reset());
 *
 * The factory imports this module lazily, so the same instance the test holds is the one the
 * mocked `../store` resolves to.
 */

export type StoredDoc = Record<string, unknown>;

class MemoryDocumentStore {
  docs: Record<string, StoredDoc> = {};

  /**
   * Fires once, inside the next transaction, after the caller's query returned and before the
   * transaction's own re-read. This is the window in which the worker claims the row, the kill
   * switch cancels it, or the send completes — whatever the test needs to have happened.
   */
  beforeTransactionRead: (() => void) | null = null;

  /** When set, every transaction throws with this message before its body runs — the datastore failing. */
  failTransactionsWith: string | null = null;
  /** When set, every plain read throws with this message — the datastore unreadable. */
  failReadsWith: string | null = null;

  reset(): void {
    this.docs = {};
    this.beforeTransactionRead = null;
    this.failTransactionsWith = null;
    this.failReadsWith = null;
  }

  /** Every document under one collection path, keyed by id. */
  collection(path: string): Record<string, StoredDoc> {
    const prefix = path + '/';
    const out: Record<string, StoredDoc> = {};
    for (const [key, value] of Object.entries(this.docs)) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        out[key.slice(prefix.length)] = value;
      }
    }
    return out;
  }

  readonly module = buildModule(this);
}

const pathOf = (ref: any): string => ref.path;

function buildModule(m: MemoryDocumentStore) {
  class StoreError extends Error {}
  const has = (path: string) => Object.prototype.hasOwnProperty.call(m.docs, path);
  const snapshot = (path: string, ref: unknown) => ({
    id: path.split('/').pop(),
    ref,
    exists: () => has(path),
    data: () => (has(path) ? { ...m.docs[path] } : undefined),
  });

  return {
    store: {},
    getStore: () => ({}),
    resetStoreForTests: () => undefined,
    tenantOf: () => null,
    assertNoUndefined: () => undefined,
    compileQuery: () => ({ text: '', values: [] }),
    StorePathError: StoreError,
    StoreValueError: StoreError,

    collection: (_db: unknown, path: string) => ({ path }),
    doc: (first: any, ...rest: any[]) => {
      if (typeof first === 'string') return { path: [first, ...rest].join('/') };
      if (first && typeof first.path === 'string') return { path: [first.path, ...rest].join('/') };
      // `first` is the database handle; the path is whatever follows it.
      return { path: rest.join('/') };
    },
    query: (c: any, ...clauses: any[]) => ({
      collectionPath: c.path,
      filters: clauses.filter((x) => x.kind === 'where'),
      limit: clauses.find((x) => x.kind === 'limit')?.value,
    }),
    where: (field: string, _op: string, value: unknown) => ({ kind: 'where', field, value }),
    limit: (value: number) => ({ kind: 'limit', value }),
    orderBy: () => ({ kind: 'orderBy' }),

    getDoc: async (ref: any) => {
      if (m.failReadsWith !== null) throw new Error(m.failReadsWith);
      return snapshot(pathOf(ref), ref);
    },
    getDocs: async (q: any) => {
      // A read that fails fails whichever shape it takes: a lookup that reads a collection must
      // report the failure the same way one that reads a document does.
      if (m.failReadsWith !== null) throw new Error(m.failReadsWith);
      // A BARE COLLECTION REFERENCE IS A VALID ARGUMENT. The real `getDocs` accepts either a
      // query or a collection reference, and `GET /api/leads` passes the latter. This double
      // used to read `q.collectionPath` only, so a bare reference produced the prefix
      // "undefined/" and returned an empty result — no error, no matches, and a suite that
      // read "the collection is empty" as a fact about the data rather than about the double.
      const collectionPath = q.collectionPath ?? q.path;
      const filters = q.filters ?? [];
      const prefix = collectionPath + '/';
      const docs = Object.entries(m.collection(collectionPath))
        .filter(([, data]) => filters.every((f: any) => (data as any)[f.field] === f.value))
        .slice(0, q.limit ?? Infinity)
        .map(([id, data]) => ({ id, ref: { path: prefix + id }, data: () => ({ ...data }) }));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn: any) => docs.forEach(fn) };
    },
    setDoc: async (ref: any, value: any) => {
      m.docs[pathOf(ref)] = { ...value };
    },
    updateDoc: async (ref: any, value: any) => {
      m.docs[pathOf(ref)] = { ...(m.docs[pathOf(ref)] ?? {}), ...value };
    },
    deleteDoc: async (ref: any) => {
      delete m.docs[pathOf(ref)];
    },
    addDoc: async (c: any, value: any) => {
      const path = `${c.path}/added-${Object.keys(m.docs).length}`;
      m.docs[path] = { ...value };
      return { path };
    },

    runTransaction: async (_db: unknown, fn: any) => {
      if (m.failTransactionsWith !== null) throw new Error(m.failTransactionsWith);
      const pendingSet: Record<string, StoredDoc> = {};
      const pendingUpdate: Record<string, StoredDoc> = {};
      const result = await fn({
        get: async (ref: any) => {
          if (m.beforeTransactionRead) {
            const fire = m.beforeTransactionRead;
            m.beforeTransactionRead = null;
            fire();
          }
          return snapshot(pathOf(ref), ref);
        },
        getAll: async (q: any) => {
          const docs = Object.entries(m.collection(q.collectionPath ?? q.path)).map(([id, data]) => ({
            id,
            ref: { path: `${q.collectionPath ?? q.path}/${id}` },
            data: () => ({ ...data }),
          }));
          return { docs, size: docs.length, empty: docs.length === 0, forEach: (cb: any) => docs.forEach(cb) };
        },
        set: (ref: any, value: any) => {
          pendingSet[pathOf(ref)] = { ...value };
        },
        update: (ref: any, value: any) => {
          pendingUpdate[pathOf(ref)] = { ...(pendingUpdate[pathOf(ref)] ?? {}), ...value };
        },
        delete: (ref: any) => {
          delete m.docs[pathOf(ref)];
        },
      });
      // Writes land at commit, after the body — a transaction that threw wrote nothing.
      for (const [path, value] of Object.entries(pendingSet)) m.docs[path] = value;
      for (const [path, value] of Object.entries(pendingUpdate)) {
        m.docs[path] = { ...(m.docs[path] ?? {}), ...value };
      }
      return result;
    },
  };
}

export const memory = new MemoryDocumentStore();
