/**
 * Stamp `schemaVersion` on outbox jobs that predate versioning.
 *
 *   npx tsx scripts/backfill-outbox-version.ts --org <id>            # dry run
 *   npx tsx scripts/backfill-outbox-version.ts --org <id> --confirm
 *
 * WHY THIS IS A SCRIPT AND NOT A DEFAULT
 * --------------------------------------
 * `readEnvelope` refuses a job with no `schemaVersion` rather than assuming it is version 1,
 * because reading an absent value as a known one is the rolling-deploy failure the versioning
 * exists to stop (S48). That refusal is correct and it is also inconvenient exactly once: at
 * the deploy that introduces it, when jobs enqueued by the previous build are still in the
 * queue.
 *
 * Resolving that is a decision about a specific queue — someone looking at these rows, in this
 * organisation, and saying they were written by the build immediately before this one. It is
 * not an inference the worker can make about every job it will ever see. So it lives here,
 * where it is deliberate, auditable and dated, rather than as a fallback in the consumer.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It only stamps jobs that have NO version. A job whose version this build does not support is
 * left alone: rewriting its version would be asserting that a payload written for one shape is
 * valid under another, which is the thing being prevented and not a repair. Those need an
 * operator, which is what DEAD_LETTER -> HUMAN_REVIEW is for.
 *
 * It also refuses to stamp a job whose payload does not parse under the version being written,
 * because a job that is dead-lettered for being malformed should stay dead-lettered rather than
 * gain a version that makes it look executable.
 */
import { firestore } from '../server/firebase';
import { orgPath } from '../server/tenancy/orgScope';
import { OUTBOX_PAYLOAD_VERSION, outboxPayloadV1 } from '../server/domain/outboxEnvelope';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import 'dotenv/config';

const CONFIRM = process.argv.includes('--confirm');
const ORG = (process.argv.find((a) => a.startsWith('--org=')) ?? '').split('=')[1] ??
  process.argv[process.argv.indexOf('--org') + 1];

if (!ORG || ORG.startsWith('--')) {
  console.error('REFUSING: pass --org <id>. The queue is per tenant and this will not guess one.');
  process.exit(2);
}

(async () => {
  if (!firestore) {
    console.error('REFUSING: no Firestore connection.');
    process.exit(2);
  }

  const snap = await getDocs(collection(firestore, orgPath(ORG, 'outbox')));
  console.log(`organisation ${ORG}: ${snap.size} job(s)`);

  const toStamp: string[] = [];
  const alreadyVersioned: number[] = [];
  const malformed: { id: string; why: string }[] = [];

  snap.forEach((d) => {
    const data = d.data() as { schemaVersion?: unknown; payload?: unknown };
    if (data.schemaVersion !== undefined && data.schemaVersion !== null) {
      alreadyVersioned.push(Number(data.schemaVersion));
      return;
    }
    const parsed = outboxPayloadV1.safeParse(data.payload);
    if (parsed.success === false) {
      malformed.push({
        id: d.id,
        why: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; '),
      });
      return;
    }
    toStamp.push(d.id);
  });

  const versions = [...new Set(alreadyVersioned)].sort();
  console.log(`  already versioned : ${alreadyVersioned.length}` +
    (versions.length > 0 ? ` (version ${versions.join(', ')})` : ''));
  console.log(`  to stamp as v${OUTBOX_PAYLOAD_VERSION}   : ${toStamp.length}`);
  console.log(`  unversioned AND malformed, left alone: ${malformed.length}`);
  for (const m of malformed.slice(0, 10)) console.log(`    - ${m.id}: ${m.why.slice(0, 120)}`);

  if (toStamp.length === 0) {
    console.log('\nNothing to do.');
    process.exit(0);
  }

  if (!CONFIRM) {
    console.log('\n--- DRY RUN. Nothing was written. Re-run with --confirm. ---');
    process.exit(0);
  }

  let stamped = 0;
  for (const id of toStamp) {
    await updateDoc(doc(firestore, orgPath(ORG, 'outbox'), id), {
      schemaVersion: OUTBOX_PAYLOAD_VERSION,
      // Recorded so the row says a person decided this, rather than looking like it was
      // enqueued by a build that stamped versions.
      schemaVersionBackfilledAt: Date.now(),
    });
    stamped++;
  }
  console.log(`\nStamped ${stamped} job(s) as version ${OUTBOX_PAYLOAD_VERSION}.`);
  process.exit(0);
})().catch((e: Error) => {
  console.error('FAILED: ' + e.message);
  process.exit(1);
});
