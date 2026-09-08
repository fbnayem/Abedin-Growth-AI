import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LOCK_STATES,
  isLockState,
  lockStateAt,
  lockDetailAt,
  lockDisplayFor,
  approvalEffectFor,
  approvalWarningFor,
  parseLockMap,
  type LockMap,
} from '../../shared/domain/autonomyDisplay';
import {
  LOCK_STATES as SERVER_LOCK_STATES,
  mayProceed,
  conversationIdsFrom,
  MAX_BATCH_IDS,
  MAX_ID_LENGTH,
} from '../domain/autonomyLock';

/**
 * INVARIANTS FOR THE OPERATOR CONSOLE'S VIEW OF THE AUTONOMY LOCK.
 *
 * The lock had two enforcers and no writer; that was fixed. It then had a writer and no
 * surface: `grep -rn 'api/autonomy' src/` returned zero, so the only way to pause a single
 * conversation was to issue the request by hand.
 *
 * These assert the two things the console can get wrong in a way that reaches a customer:
 *
 *   1. Displaying "autonomy active" for a conversation whose lock it did not read (§14).
 *   2. Promising that Approve will send when the worker will dead-letter the message.
 */

const RUNNING_MAP: LockMap = {
  'conv-1': { state: 'RUNNING', reason: null, actor: null, at: null },
  'conv-2': { state: 'PAUSED', reason: 'customer called in', actor: 'ops@example.com', at: 't' },
};

describe('1. every way of not knowing the lock is UNKNOWN', () => {
  /**
   * The list is exhaustive on purpose. Each entry is a distinct route by which this console
   * used to have no state at all, and the defect being prevented is any one of them arriving
   * at a green badge.
   */
  const BLIND: Array<[string, LockMap | null | undefined, string | null | undefined]> = [
    ['the request has not returned yet', null, 'conv-1'],
    ['the request failed and there is no map', undefined, 'conv-1'],
    ['the server answered with no conversations', {}, 'conv-1'],
    ['this conversation was not in the answer', RUNNING_MAP, 'conv-absent'],
    ['the row carries no conversation id', RUNNING_MAP, undefined],
    ['the row carries a null conversation id', RUNNING_MAP, null],
    ['the row carries an empty conversation id', RUNNING_MAP, ''],
  ];

  for (const [why, map, id] of BLIND) {
    it(`UNKNOWN when ${why}`, () => {
      expect(lockStateAt(map, id)).toBe('UNKNOWN');
    });
  }

  it('an entry whose state this build does not recognise is UNKNOWN, not permission', () => {
    // The body arrives over the network. `'ACTIVE' !== 'PAUSED'` must not become a green badge
    // by elimination — which is what any implementation written as "paused or else running"
    // would do.
    for (const bad of ['ACTIVE', 'running', 'Running', 'OPEN', '', 'PAUSED ', 0, 1, true, null, undefined, {}, []]) {
      const map = { 'conv-x': { state: bad, reason: null, actor: null, at: null } } as unknown as LockMap;
      expect(lockStateAt(map, 'conv-x'), `accepted ${JSON.stringify(bad)}`).toBe('UNKNOWN');
    }
  });

  it('a malformed entry is UNKNOWN', () => {
    for (const bad of [null, 'RUNNING', 42, undefined]) {
      const map = { 'conv-x': bad } as unknown as LockMap;
      expect(lockStateAt(map, 'conv-x'), `accepted ${JSON.stringify(bad)}`).toBe('UNKNOWN');
    }
  });

  /**
   * THE INPUT THAT MAKES THE hasOwnProperty GUARD LOAD-BEARING.
   *
   * Removing the guard was mutation-tested and SURVIVED the first run, and the obvious reading
   * — that it is an equivalent mutant, since `constructor` resolves to a function and a
   * function fails `typeof entry === 'object'` — was wrong. Measured both ways, one input
   * separates them.
   *
   * `out[id] = entry` for the key `__proto__` does not create an own property. It invokes the
   * `__proto__` setter and replaces the object's PROTOTYPE with the entry. A bare
   * `locks['__proto__']` then reads that entry back: an object, with a real `state`. Without
   * the guard the console shows "autonomy active" for a conversation it never read.
   *
   * Reachable rather than hypothetical: `assertDocumentId` admits `__proto__` — a non-empty
   * string with no `/` — so a conversation can be called that.
   */
  it('a map whose PROTOTYPE was moved by a `__proto__` key still reads UNKNOWN', () => {
    const built: Record<string, unknown> = {};
    // Exactly what a parser written with `{}` and bare assignment does.
    (built as Record<string, unknown>)['__proto__'] = {
      state: 'RUNNING',
      reason: null,
      actor: null,
      at: null,
    };
    expect(lockStateAt(built as unknown as LockMap, '__proto__')).toBe('UNKNOWN');
    // And nothing else inherits an answer from it either.
    expect(lockStateAt(built as unknown as LockMap, 'conv-1')).toBe('UNKNOWN');
  });

  it('an inherited property is not an answer', () => {
    // Without the hasOwnProperty guard, `locks['constructor']` resolves to Object's own
    // constructor — an object, so the `typeof` check passes, and only the state check saves
    // it. Two guards because one of them passing by accident is not a guard.
    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(lockStateAt({}, inherited), `${inherited} resolved to something`).toBe('UNKNOWN');
    }
  });

  it('a state that WAS read is reported as read', () => {
    // The other half: a function returning UNKNOWN unconditionally satisfies every assertion
    // above, and would make the console useless while looking safe.
    expect(lockStateAt(RUNNING_MAP, 'conv-1')).toBe('RUNNING');
    expect(lockStateAt(RUNNING_MAP, 'conv-2')).toBe('PAUSED');
  });

  it('isLockState admits exactly the three states', () => {
    for (const state of LOCK_STATES) expect(isLockState(state)).toBe(true);
    for (const bad of ['ACTIVE', 'paused', 'STOPPED', '', null, undefined, 1, {}]) {
      expect(isLockState(bad), `admitted ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('1b. the response body is narrowed before it becomes state', () => {
  it('keeps the entries it can read', () => {
    const map = parseLockMap({
      locks: {
        a: { state: 'PAUSED', reason: 'called in', actor: 'ops@example.com', at: 't' },
        b: { state: 'RUNNING', reason: null, actor: null, at: null },
      },
    });
    expect(lockStateAt(map, 'a')).toBe('PAUSED');
    expect(map.a.reason).toBe('called in');
    expect(lockStateAt(map, 'b')).toBe('RUNNING');
  });

  /**
   * THE MUTANT THAT SURVIVED UNTIL THIS FUNCTION MOVED.
   *
   * While this parser lived inside `OutboxView.tsx`, changing `Object.create(null)` back to
   * `{}` passed the whole gate — nothing under `environment: 'node'` can import a decision
   * that sits in a component module. The behaviour was correct and unreachable, which is the
   * same statement the route made twice before it.
   *
   * With `{}`, `out['__proto__'] = entry` moves this object's prototype instead of adding a
   * key, and the console then reads that entry back for a conversation the server never
   * reported.
   */
  it('a conversation literally named __proto__ cannot move the map prototype', () => {
    const map = parseLockMap({
      locks: { __proto__: { state: 'RUNNING', reason: null, actor: null, at: null } },
    });
    expect(lockStateAt(map, '__proto__')).toBe('UNKNOWN');
    expect(lockStateAt(map, 'anything-else')).toBe('UNKNOWN');
    expect(Object.getPrototypeOf(map)).toBeNull();
  });

  it('drops entries whose state this build does not know', () => {
    const map = parseLockMap({
      locks: {
        good: { state: 'PAUSED', reason: null, actor: null, at: null },
        bad: { state: 'ACTIVE', reason: null, actor: null, at: null },
        worse: 'RUNNING',
        empty: null,
      },
    });
    expect(lockStateAt(map, 'good')).toBe('PAUSED');
    for (const id of ['bad', 'worse', 'empty']) {
      expect(lockStateAt(map, id), `${id} survived narrowing`).toBe('UNKNOWN');
    }
  });

  it('a body that is not the expected shape yields an empty map, not a throw', () => {
    // A proxy error page, a 200 with an HTML body, an older server: the console has to render
    // something, and an empty map renders every row as unreadable, which refuses.
    for (const body of [null, undefined, {}, { locks: null }, { locks: 'nope' }, [], 'text', 42]) {
      const map = parseLockMap(body);
      expect(lockStateAt(map, 'conv-1'), `body ${JSON.stringify(body)}`).toBe('UNKNOWN');
    }
  });

  it('non-string metadata is nulled rather than rendered', () => {
    const map = parseLockMap({
      locks: { a: { state: 'PAUSED', reason: { evil: true }, actor: 42, at: [] } },
    });
    expect(map.a.reason).toBeNull();
    expect(map.a.actor).toBeNull();
    expect(map.a.at).toBeNull();
  });
});

describe('2. the console and the enforcement cannot disagree', () => {
  /**
   * THE LOAD-BEARING ASSERTION IN THIS FILE.
   *
   * `mayProceed` is what the gateway and the worker actually branch on. `approvalEffectFor` is
   * what the console promises the operator. If those two ever diverge, the console is lying
   * about the system's behaviour — telling someone a message will send when it will be
   * dead-lettered, or the reverse.
   *
   * Asserted across every declared state rather than for the three known ones, so adding a
   * fourth state fails here instead of silently defaulting on one side.
   */
  it('Approve promises a send exactly when the guards permit one', () => {
    for (const state of LOCK_STATES) {
      expect(
        approvalEffectFor(state) === 'SENDS',
        `console and enforcement disagree about ${state}`
      ).toBe(mayProceed(state));
    }
  });

  it('the shared union and the enforcement module are the same list', () => {
    // They are one definition re-exported, and this is what keeps that true: a copy made later
    // "to avoid the import" would pass tsc and diverge on the next state added.
    expect([...SERVER_LOCK_STATES]).toEqual([...LOCK_STATES]);
  });

  it('only RUNNING sends', () => {
    expect(approvalEffectFor('RUNNING')).toBe('SENDS');
    for (const state of LOCK_STATES.filter((s) => s !== 'RUNNING')) {
      expect(approvalEffectFor(state), `${state} was treated as sendable`).toBe('DEAD_LETTERS');
    }
  });
});

describe('3. what the operator is told', () => {
  it('a warning is shown exactly when approval will not send', () => {
    for (const state of LOCK_STATES) {
      const warning = approvalWarningFor(state);
      if (approvalEffectFor(state) === 'SENDS') {
        expect(warning, `${state} carried a warning but sends`).toBeNull();
      } else {
        expect(warning, `${state} sends nothing and said nothing`).not.toBeNull();
        expect(warning!.length).toBeGreaterThan(20);
      }
    }
  });

  it('the warning names the outcome rather than only refusing', () => {
    // "This conversation is paused" is not enough. The operator's question is what happens to
    // the message they are looking at, and the answer — it is dead-lettered and needs a second
    // decision to recover — is the part that was missing entirely.
    for (const state of ['PAUSED', 'UNKNOWN'] as const) {
      expect(approvalWarningFor(state)!.toLowerCase()).toContain('dead-letter');
    }
  });

  it('UNKNOWN is never displayed as paused-by-a-human', () => {
    // Both refuse, so folding them together would be safe for dispatch and wrong for the
    // operator: one is cleared by resuming, the other by finding out why the store did not
    // answer. Telling someone a human paused a conversation nobody paused sends them looking
    // for a person.
    const unknown = lockDisplayFor('UNKNOWN');
    const paused = lockDisplayFor('PAUSED');
    expect(unknown.label).not.toBe(paused.label);
    expect(unknown.tone).not.toBe(paused.tone);
    expect(unknown.label.toLowerCase()).not.toContain('human');
  });

  it('every state has its own tone and label', () => {
    const tones = LOCK_STATES.map((s) => lockDisplayFor(s).tone);
    const labels = LOCK_STATES.map((s) => lockDisplayFor(s).label);
    expect(new Set(tones).size).toBe(LOCK_STATES.length);
    expect(new Set(labels).size).toBe(LOCK_STATES.length);
  });

  it('resume is offered only for a lock that was actually read as paused', () => {
    // A resume writes an explicit `false`, and `lockStateOf` gives an explicit `false`
    // precedence over the legacy `AUTONOMY_PAUSED_BY_HUMAN` status. So resuming against a lock
    // nobody could read is the one write in this system able to restart a conversation
    // somebody deliberately stopped.
    expect(lockDisplayFor('PAUSED').offerResume).toBe(true);
    expect(lockDisplayFor('UNKNOWN').offerResume).toBe(false);
    expect(lockDisplayFor('RUNNING').offerResume).toBe(false);
  });

  it('lockDetailAt withholds metadata for a state it could not confirm', () => {
    expect(lockDetailAt(RUNNING_MAP, 'conv-2')?.reason).toBe('customer called in');
    expect(lockDetailAt(RUNNING_MAP, 'conv-absent')).toBeNull();
    expect(lockDetailAt(null, 'conv-1')).toBeNull();
    // An entry carrying a reason but an uninterpretable state: showing the reason beside
    // "unreadable" reads as an explanation of a state we do not have.
    const odd = { 'c': { state: 'ACTIVE', reason: 'looks authoritative', actor: null, at: null } };
    expect(lockDetailAt(odd as unknown as LockMap, 'c')).toBeNull();
  });
});

describe('4. the batch id list is bounded, and refuses rather than truncates', () => {
  it('absent and empty both mean "no conversations"', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const parsed = conversationIdsFrom(raw);
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.ids).toEqual([]);
    }
  });

  it('parses, trims and de-duplicates while preserving order', () => {
    const parsed = conversationIdsFrom(' b , a ,b, c ');
    expect(parsed.ok && parsed.ids).toEqual(['b', 'a', 'c']);
  });

  it('an empty entry is refused, not skipped', () => {
    // Skipping it means the caller asked about three conversations and got two, and the third
    // renders as "lock unreadable" — sending an operator to look for a datastore fault that is
    // really a typo in a query string.
    const parsed = conversationIdsFrom('a,,b');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/empty/i);
  });

  it('a repeated query parameter is refused rather than joined', () => {
    // Express turns `?conversationIds=a&conversationIds=b` into an array. Accepting it would
    // make two spellings of one request, only one of which this parser bounds.
    const parsed = conversationIdsFrom(['a', 'b']);
    expect(parsed.ok).toBe(false);
  });

  it('an id that would change the shape of a store path is refused here, not at the store', () => {
    // Reaching `assertDocumentId` throws StorePathError, which `sendCaught` answers as 500 — an
    // input error reported as a server fault.
    for (const bad of ['a/b', '..', '.', 'organizations/acme/x']) {
      const parsed = conversationIdsFrom(bad);
      expect(parsed.ok, `accepted ${bad}`).toBe(false);
    }
  });

  it('an over-long id is refused', () => {
    expect(conversationIdsFrom('x'.repeat(MAX_ID_LENGTH)).ok).toBe(true);
    expect(conversationIdsFrom('x'.repeat(MAX_ID_LENGTH + 1)).ok).toBe(false);
  });

  it('the cap refuses the request and names the count; it never returns a short list', () => {
    const exactly = Array.from({ length: MAX_BATCH_IDS }, (_, i) => `c${i}`).join(',');
    const parsedExact = conversationIdsFrom(exactly);
    expect(parsedExact.ok).toBe(true);
    expect(parsedExact.ok && parsedExact.ids).toHaveLength(MAX_BATCH_IDS);

    const tooMany = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `c${i}`).join(',');
    const parsed = conversationIdsFrom(tooMany);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain(String(MAX_BATCH_IDS + 1));
  });

  it('duplicates are collapsed BEFORE the cap is applied', () => {
    // Otherwise a console showing 60 messages from one conversation is refused for asking
    // about one conversation.
    const parsed = conversationIdsFrom(Array(MAX_BATCH_IDS + 50).fill('same').join(','));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.ids).toEqual(['same']);
  });
});

describe('5. the console reaches the control, and the claim about Approve is true of the worker', () => {
  const outboxView = readFileSync('src/pages/OutboxView.tsx', 'utf8');
  const worker = readFileSync('server/workers/outbox.worker.ts', 'utf8');
  const service = readFileSync('server/services/outbox.service.ts', 'utf8');

  it('the frontend calls the autonomy endpoint at all', () => {
    // This is the whole finding in one assertion: before this change the count was zero across
    // the entire `src/` tree, while two server-side guards enforced a flag nothing could set.
    expect(outboxView).toContain('/api/autonomy');
  });

  it('the dead-letter recovery path has a surface too', () => {
    // S38 built `POST /:id/requeue` as the way back, and the console filtered DEAD_LETTER rows
    // out of the list entirely, so the only way to reach it was curl.
    expect(outboxView).toContain('/requeue');
    expect(outboxView).toContain('DEAD_LETTER');
  });

  /**
   * A SOURCE-SHAPE ASSERTION, AND ITS LIMITS ARE STATED.
   *
   * The claim in `approvalWarningFor` is about behaviour two modules away: approving on a
   * paused conversation dead-letters the message. That is the sentence an operator acts on, so
   * it should not rot silently — but nothing here can run the worker, which needs a live store
   * and a provider.
   *
   * So this checks the two links in the chain by shape, and the self-check below proves the
   * pattern can fail. It does NOT prove the worker runs; `store:verify` and the outbox suite
   * cover the queue itself.
   */
  it('the worker refuses a locked conversation TERMINALLY', () => {
    const refusal = /if \(!mayProceed\(lock\)\) \{[\s\S]{0,400}?markFailed\([^)]*\)/.exec(worker);
    expect(refusal, 'the lock refusal block moved or changed shape').not.toBeNull();
    expect(refusal![0]).toMatch(/markFailed\([^)]*,\s*true\s*\)/);
  });

  it('markFailed with terminal=true writes DEAD_LETTER', () => {
    expect(service).toMatch(/if \(terminal \|\|[\s\S]{0,200}?status: 'DEAD_LETTER'/);
  });

  it('those two patterns would fail if the behaviour changed', () => {
    // Without this, a pattern matching nothing satisfies both assertions above forever.
    const nonTerminal = "if (!mayProceed(lock)) {\n await outboxService.markFailed(orgId, job.id, LOCK_STATUS, false);\n}";
    expect(/markFailed\([^)]*,\s*true\s*\)/.test(nonTerminal)).toBe(false);

    const retryInstead = "if (terminal || attempts >= MAX_ATTEMPTS) {\n tx.update(ref, { status: 'PENDING'";
    expect(/if \(terminal \|\|[\s\S]{0,200}?status: 'DEAD_LETTER'/.test(retryInstead)).toBe(false);
  });
});
