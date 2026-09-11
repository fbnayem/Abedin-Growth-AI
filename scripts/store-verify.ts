import 'dotenv/config';
import {
  store,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  StoreValueError,
} from '../server/store';

/**
 * PROVE THE DOCUMENT STORE AGAINST THE REAL DATABASE.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 * -----------------------------------
 * CI has no database. A vitest suite that skipped when the store was unreachable would report
 * green having touched nothing, which is the exact failure this repository's audit exists to
 * catch — so the properties that need PostgreSQL live here, run deliberately, the way
 * `scripts/db-verify.ts` is. `server/tests/store.invariant.test.ts` proves the pure half in CI
 * and says in its own header that it cannot prove this half.
 *
 * WHAT IT PROVES THAT THE UNIT SUITE CANNOT
 * -----------------------------------------
 * Chiefly: that concurrent transactions do not lose updates. Firestore aborted a transaction
 * when a document it had read changed before commit, and `mutateWithVersion`, the outbox claim
 * and the human-ownership lock were all written against that guarantee. Replacing it with
 * `BEGIN ISOLATION LEVEL SERIALIZABLE` is only equivalent if PostgreSQL actually detects the
 * conflict AND the retry actually re-runs the body — neither of which a mock can establish and
 * both of which every one of those call sites depends on.
 *
 * It connects as the RUNTIME role (DATABASE_URL), not the migration owner, so a missing GRANT
 * on `documents` shows up here rather than at 3am. A GRANT statement that ran without error is
 * not evidence that the application can write a row.
 *
 * It writes only under `organizations/__verify__/...` and deletes what it wrote.
 */

const TENANT = '__verify__';
const CONTACTS = `organizations/${TENANT}/contacts`;
const QUEUE = `organizations/${TENANT}/outbox`;

const problems: string[] = [];
let checks = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  checks++;
  const status = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${status}  ${label}${detail ? '   ' + detail : ''}`);
  if (!condition) problems.push(label);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  // A local const: `store` is an imported binding, and TypeScript does not keep a narrowing
  // of one across the closures below, so `handle.pool` read as possibly-null inside them.
  const handle = store;
  if (!handle) {
    console.error(
      'REFUSING: no database configured. Set DATABASE_URL (or SQL_HOST/SQL_USER/SQL_PASSWORD).\n' +
        'This script exists to prove the store against a real PostgreSQL instance; there is ' +
        'nothing it can honestly report without one.'
    );
    process.exit(2);
  }

  const wipe = async () =>
    handle.pool.query('DELETE FROM documents WHERE org_id = $1', [TENANT]);
  await wipe();

  // ---------------------------------------------------------------- 1. privileges
  section('1. the runtime role can actually use the table');
  {
    const a = doc(store, CONTACTS, 'priv');
    await setDoc(a, { probe: true });
    ok('INSERT', (await getDoc(a)).exists());
    await updateDoc(a, { probe: false });
    ok('UPDATE', (await getDoc(a)).data()?.probe === false);
    await deleteDoc(a);
    ok('DELETE', (await getDoc(a)).exists() === false);
  }

  // ---------------------------------------------------------------- 2. round trip
  section('2. documents round-trip with their types intact');
  {
    const a = doc(store, CONTACTS, 'a1');
    await setDoc(a, {
      name: 'Ada',
      active: true,
      score: 42,
      tags: ['x', 'y'],
      nested: { deep: { value: null } },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const d = (await getDoc(a)).data() as any;
    ok('string', d.name === 'Ada');
    ok('boolean stays boolean', d.active === true && typeof d.active === 'boolean');
    ok('number stays number', d.score === 42 && typeof d.score === 'number');
    ok('array stays array', Array.isArray(d.tags) && d.tags.length === 2);
    ok('nested null survives', d.nested.deep.value === null);
  }

  // ---------------------------------------------------------------- 3. set vs update vs merge
  section('3. replace, merge and update mean three different things');
  {
    const a = doc(store, CONTACTS, 'a1');
    await setDoc(a, { name: 'Ada', active: true });
    ok('setDoc REPLACES — a field not written is gone', (await getDoc(a)).data()?.score === undefined);

    await setDoc(a, { score: 7 }, { merge: true });
    const merged = (await getDoc(a)).data() as any;
    ok('merge keeps what it does not mention', merged.name === 'Ada' && merged.score === 7);

    await updateDoc(a, { name: 'Ada Lovelace' });
    ok('updateDoc merges', (await getDoc(a)).data()?.name === 'Ada Lovelace');

    let refused = false;
    try {
      await updateDoc(doc(store, CONTACTS, 'does-not-exist'), { x: 1 });
    } catch (e) {
      refused = e instanceof StoreValueError;
    }
    ok('updateDoc REFUSES a missing document rather than creating one', refused);

    const created = doc(store, CONTACTS, 'created-by-merge');
    await setDoc(created, { v: 1 }, { merge: true });
    ok('a merging set DOES create — draftIntegrity relies on it', (await getDoc(created)).exists());
    await deleteDoc(created);
  }

  // ---------------------------------------------------------------- 4. queries
  section('4. queries filter, order and cap');
  {
    await setDoc(doc(store, CONTACTS, 'a1'), { name: 'Ada', active: true, createdAt: '2026-01-01T00:00:00.000Z' });
    await setDoc(doc(store, CONTACTS, 'b1'), { name: 'Bob', active: false, createdAt: '2026-02-01T00:00:00.000Z' });
    await setDoc(doc(store, CONTACTS, 'c1'), { name: 'Cyd', active: true, createdAt: '2026-03-01T00:00:00.000Z' });

    const actives = await getDocs(query(collection(store, CONTACTS), where('active', '==', true)));
    ok('equality filters', actives.size === 2, `got ${actives.size}`);

    const asString = await getDocs(
      query(collection(store, CONTACTS), where('active', '==', 'true' as never))
    );
    ok('a string does NOT match a boolean', asString.size === 0, `got ${asString.size}`);

    const newest = await getDocs(
      query(collection(store, CONTACTS), orderBy('createdAt', 'desc'), limit(1))
    );
    ok('orderBy desc + limit', (newest.docs[0]?.data() as any)?.name === 'Cyd');

    const oldest = await getDocs(
      query(collection(store, CONTACTS), orderBy('createdAt', 'asc'), limit(1))
    );
    ok('orderBy asc', (oldest.docs[0]?.data() as any)?.name === 'Ada');

    const missing = await getDocs(
      query(collection(store, CONTACTS), where('nosuchfield', '==', 'x'))
    );
    ok('a document missing the field is excluded', missing.empty);

    const added = await addDoc(collection(store, CONTACTS), { name: 'Dee', active: false });
    ok('addDoc generates an id and writes', (await getDoc(added)).exists());
    await deleteDoc(added);
  }

  // ---------------------------------------------------------------- 5. tenancy
  section('5. the tenant is stored as a column, derived from the path');
  {
    const rows = await handle.pool.query(
      'SELECT DISTINCT org_id FROM documents WHERE path LIKE $1',
      [`organizations/${TENANT}/%`]
    );
    ok('org_id is derived and stored', rows.rows.length === 1 && rows.rows[0].org_id === TENANT);

    const topLevel = doc(store, 'system_settings', 'probe');
    await setDoc(topLevel, { v: 1 });
    const t = await handle.pool.query(
      'SELECT org_id FROM documents WHERE path = $1 AND id = $2',
      ['system_settings', 'probe']
    );
    ok('a top-level collection stores NULL, not a fabricated tenant', t.rows[0].org_id === null);
    await deleteDoc(topLevel);

    const foreign = await handle.pool.query(
      'SELECT count(*)::int AS n FROM documents WHERE org_id = $1 AND path NOT LIKE $2',
      [TENANT, `organizations/${TENANT}/%`]
    );
    ok('no row claims this tenant from outside its path', foreign.rows[0].n === 0);
  }

  // ---------------------------------------------------------------- 6. transactions
  section('6. transactions commit, roll back, and see their own writes');
  {
    const a = doc(store, CONTACTS, 'tx');
    await setDoc(a, { v: 1 });

    await runTransaction(store, async (tx) => {
      await tx.set(a, { v: 2 });
    });
    ok('a committed transaction persists', (await getDoc(a)).data()?.v === 2);

    try {
      await runTransaction(store, async (tx) => {
        await tx.set(a, { v: 999 });
        throw new Error('deliberate');
      });
    } catch {
      /* expected */
    }
    ok('a thrown transaction rolls back completely', (await getDoc(a)).data()?.v === 2);

    // Documented difference from Firestore, pinned so it is found by a failing check rather
    // than by a wrong value in production.
    let seen: unknown;
    await runTransaction(store, async (tx) => {
      await tx.set(a, { v: 3 });
      seen = (await tx.get(a)).data()?.v;
    });
    ok('a transaction SEES its own writes (Firestore did not)', seen === 3);
  }

  // ------------------------------------------------- 7. the property everything depends on
  section('7. concurrent transactions do not lose updates');
  {
    // This is the guarantee `mutateWithVersion`, the outbox claim and the ownership lock were
    // all written against. Under Firestore it came from aborting on a changed read; here it
    // comes from SERIALIZABLE plus the retry in runTransaction. If either half is wrong, the
    // final count is less than the number of writers and every one of those call sites is
    // silently unsafe.
    const counter = doc(store, CONTACTS, 'counter');
    await setDoc(counter, { n: 0 });

    const WRITERS = 8;
    await Promise.all(
      Array.from({ length: WRITERS }, () =>
        runTransaction(store, async (tx) => {
          const current = Number((await tx.get(counter)).data()?.n ?? 0);
          await tx.set(counter, { n: current + 1 });
        })
      )
    );
    const total = Number((await getDoc(counter)).data()?.n);
    ok(
      `${WRITERS} concurrent read-modify-writes all land`,
      total === WRITERS,
      `n = ${total} (want ${WRITERS})`
    );

    // The outbox claim, in miniature: many workers, one job, exactly one winner.
    const job = doc(store, QUEUE, 'j1');
    await setDoc(job, { status: 'PENDING' });

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runTransaction(store, async (tx) => {
          const snap = await tx.get(job);
          if (snap.data()?.status !== 'PENDING') return null;
          await tx.set(job, { status: 'PROCESSING', worker: `w${i}` });
          return `w${i}`;
        }).catch(() => null)
      )
    );
    const winners = claims.filter((c) => c !== null);
    ok('exactly one worker claims a job', winners.length === 1, `winners: ${winners.join(', ')}`);
    ok('the claimed job records its winner', (await getDoc(job)).data()?.worker === winners[0]);
  }

  // ---------------------------------------------------------------- 8. refusals
  section('8. the store refuses what it cannot store faithfully');
  {
    let refused = false;
    try {
      await setDoc(doc(store, CONTACTS, 'bad'), { payload: { to: undefined } });
    } catch (e) {
      refused = e instanceof StoreValueError;
    }
    ok('undefined is refused rather than dropped', refused);
    ok('and nothing was written', (await getDoc(doc(store, CONTACTS, 'bad'))).exists() === false);
  }

  // ---------------------------------------------------------------- clean up
  await wipe();
  const left = await handle.pool.query(
    'SELECT count(*)::int AS n FROM documents WHERE org_id = $1',
    [TENANT]
  );
  ok('the verifier cleaned up after itself', left.rows[0].n === 0);

  await handle.pool.end();

  console.log('');
  if (problems.length > 0) {
    console.error(`${problems.length} of ${checks} CHECKS FAILED:`);
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`ALL ${checks} CHECKS PASSED.`);
}

main().catch((e) => {
  console.error('store-verify failed:', e?.message ?? e);
  process.exit(1);
});
