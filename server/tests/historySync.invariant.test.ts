import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * S19 / P0.5 — the loop an anonymous caller can drive.
 *
 * `/api/webhooks/gmail` is auth-exempt (the bypass is a `req.path.includes('/webhook')`
 * SUBSTRING test, not an allowlist) and signature-unverified, and it calls straight into the
 * history sync. Two consequences were live: the caller's `historyId` was interpolated into a
 * request URL unvalidated, and the per-message loop that follows — several model calls each —
 * had no bound at all. The cost of one request to us was set by the party making it.
 */

// ---------------------------------------------------------------------------
// Doubles. The datastore double matters: `db` is a Proxy that throws on any property access
// when DATABASE_URL is unset, so without this the method under test dies on its first line and
// the test would prove only that the catch block exists.
// ---------------------------------------------------------------------------
let oauthRows: any[] = [];
let messageRows: any[] = [];
/** Counted, because "the cap is applied before the datastore read" is a claim about a number. */
let messageQueries = 0;

vi.mock('../db/index', () => ({
  db: {
    select: () => ({
      from: (table: any) => ({
        where: () => {
          const isOauth = String(table?.[Symbol.for('drizzle:Name')] ?? '').includes('oauth');
          if (!isOauth) messageQueries++;
          const rows: any = isOauth ? oauthRows : messageRows;
          const result: any = [...rows];
          result.limit = () => [...rows];
          return result;
        },
      }),
    }),
  },
}));

let historyPages: any[] = [];
let getHistoryThrows: unknown = null;
let getMessageCalls: string[] = [];

vi.mock('../services/gmail.service', async () => {
  const actual = await vi.importActual<typeof import('../services/gmail.service')>(
    '../services/gmail.service'
  );
  return {
    ...actual,
    gmailService: {
      setCredentials: () => undefined,
      getHistory: async () => {
        if (getHistoryThrows !== null) throw getHistoryThrows;
        return historyPages;
      },
      getMessage: async (id: string) => {
        getMessageCalls.push(id);
        return { id, threadId: 't', from: 'a@b.example' } as any;
      },
    },
  };
});

let pipelineCalls: string[] = [];
vi.mock('../services/inboundPipeline', () => ({
  inboundPipeline: {
    processNewEmail: async (msg: any) => {
      pipelineCalls.push(msg.id);
      return { ok: true, disposition: 'QUEUED', detail: 'x', modelCalls: [] };
    },
  },
}));

const { GmailHistorySyncService, MAX_MESSAGES_PER_NOTIFICATION } = await import(
  '../services/gmailHistorySync.service'
);
const { isValidHistoryId, GmailService } = await import('../services/gmail.service');

const messagesAdded = (n: number) => [
  { messagesAdded: Array.from({ length: n }, (_, i) => ({ message: { id: `m${i}` } })) },
];

// ===========================================================================
describe('a history id is an unsigned decimal, or it is not a history id (S19)', () => {
  it('accepts what Gmail issues', () => {
    for (const ok of ['1', '42', '1234567890', '9'.repeat(20)]) {
      expect(isValidHistoryId(ok), ok).toBe(true);
    }
  });

  it('REJECTS THE INJECTION SHAPES', () => {
    for (const bad of [
      '1&labelId=x',
      '1#',
      '1 OR 1=1',
      '../../users/me/messages',
      '1%26',
      'abc',
      '',
      '0',
      '01',
      '-1',
      '1.5',
      '9'.repeat(21),
      null,
      undefined,
      42,
    ]) {
      expect(isValidHistoryId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the adapter refuses to build a request from one, without touching the network', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const svc = new GmailService();
    svc.setCredentials({ access_token: 'tok' });
    await expect(svc.getHistory('1&labelId=x', 'a@b.example')).rejects.toMatchObject({
      kind: 'INVALID_REQUEST',
    });
    expect(called).toBe(false);
    vi.unstubAllGlobals();
  });

  it('a valid id is encoded on the way into the URL', async () => {
    let url = '';
    vi.stubGlobal('fetch', async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ history: [] }) };
    });
    const svc = new GmailService();
    svc.setCredentials({ access_token: 'tok' });
    await svc.getHistory('12345', 'a@b.example');
    expect(url).toContain('startHistoryId=12345');
    vi.unstubAllGlobals();
  });
});

// ===========================================================================
describe('P0.5 — the cost of one notification is bounded by us, not by the caller', () => {
  let sync: any;

  beforeEach(() => {
    oauthRows = [{ provider: 'GMAIL', accessToken: 'tok', organizationId: 'org_1' }];
    messageRows = [];
    historyPages = [];
    getHistoryThrows = null;
    getMessageCalls = [];
    messageQueries = 0;
    pipelineCalls = [];
    sync = new GmailHistorySyncService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a modest notification is processed in full', async () => {
    historyPages = messagesAdded(3);
    await sync.processEvent('a@b.example', '100');
    expect(pipelineCalls.length).toBe(3);
  });

  it('THE LOOP IS CAPPED — a notification claiming 500 messages costs 25', async () => {
    historyPages = messagesAdded(500);
    await sync.processEvent('a@b.example', '100');
    expect(pipelineCalls.length).toBe(MAX_MESSAGES_PER_NOTIFICATION);
    // and the expensive fetch is capped too, not merely the pipeline call
    expect(getMessageCalls.length).toBe(MAX_MESSAGES_PER_NOTIFICATION);
  });

  it('the cap counts BEFORE the datastore read, so the cheap work is bounded as well', async () => {
    // Counting after the dedupe read would leave an unauthenticated caller able to drive an
    // unbounded number of QUERIES even with the model calls capped. The first version of this
    // test asserted only that `getMessage` was capped, which would have passed either way.
    historyPages = messagesAdded(200);
    messageQueries = 0;
    await sync.processEvent('a@b.example', '100');
    expect(messageQueries).toBe(MAX_MESSAGES_PER_NOTIFICATION);
  });

  it('TRUNCATION IS REPORTED, NOT SILENT', async () => {
    // Silent truncation reads as "we handled everything".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    historyPages = messagesAdded(100);
    await sync.processEvent('a@b.example', '100');
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toContain('DEFERRED');
    expect(said).toContain('re-delivers');
    warn.mockRestore();
  });

  it('nothing is deferred when nothing exceeded the cap, and nothing is said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    historyPages = messagesAdded(2);
    await sync.processEvent('a@b.example', '100');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('DEFERRED');
    warn.mockRestore();
  });

  it('a malformed history id is refused before the datastore is touched', async () => {
    historyPages = messagesAdded(5);
    await sync.processEvent('a@b.example', '1&labelId=x');
    expect(pipelineCalls.length).toBe(0);
    expect(getMessageCalls.length).toBe(0);
  });

  it('an already-stored message is skipped without spending a model call', async () => {
    historyPages = messagesAdded(2);
    messageRows = [{ providerMessageId: 'm0' }];
    await sync.processEvent('a@b.example', '100');
    // the double returns the same rows for every id, so both are treated as present
    expect(pipelineCalls.length).toBe(0);
  });
});

// ===========================================================================
describe('an expired cursor is recognised by its status, not by its prose', () => {
  let sync: any;

  beforeEach(() => {
    oauthRows = [{ provider: 'GMAIL', accessToken: 'tok', organizationId: 'org_1' }];
    messageRows = [];
    historyPages = [];
    getHistoryThrows = null;
    pipelineCalls = [];
    getMessageCalls = [];
    messageQueries = 0;
    sync = new GmailHistorySyncService();
  });

  it('A 404 TRIGGERS THE EXPIRATION PATH, WHATEVER THE MESSAGE SAYS', async () => {
    // Was `e.message?.includes('historyId is out of date')`. This repository has a guardrail
    // against classifying errors by substring, and this file was its one documented exception.
    const { ProviderError } = await import('../lib/providerError');
    getHistoryThrows = new ProviderError({
      provider: 'gmail',
      operation: 'getHistory',
      kind: 'NOT_FOUND',
      status: 404,
      signal: 'http status=404',
    });
    const spy = vi.spyOn(sync, 'handleHistoryExpiration').mockResolvedValue(undefined);
    await sync.processEvent('a@b.example', '100');
    expect(spy).toHaveBeenCalledWith('a@b.example');
  });

  it('an unrelated failure does NOT trigger it', async () => {
    getHistoryThrows = Object.assign(new Error('historyId is out of date'), { code: 'ECONNRESET' });
    const spy = vi.spyOn(sync, 'handleHistoryExpiration').mockResolvedValue(undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await sync.processEvent('a@b.example', '100');
    // The message SAYS the cursor expired. The structure says the connection broke. The
    // structure wins — which is the entire point, and the reverse of what the old test did.
    expect(spy).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join(' ')).toContain('CONNECTION_FAILED');
    err.mockRestore();
  });

  it('THE FULL-SYNC STUB SAYS IT IS NOT IMPLEMENTED, LOUDLY', async () => {
    // It used to log "Performing full sync." above an empty body. An operator reading that log
    // would reasonably believe the mailbox had resynchronised.
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new GmailHistorySyncService().handleHistoryExpiration('a@b.example');
    const said = err.mock.calls.flat().join(' ');
    expect(said).toContain('NOT IMPLEMENTED');
    expect(said).not.toContain('Performing full sync');
    err.mockRestore();
  });
});

// ===========================================================================
describe('the guardrail has one fewer exception', () => {
  it('the substring-classification allowance is empty', () => {
    const guard = readFileSync('scripts/check-no-substring-error-classification.mjs', 'utf8');
    expect(guard).toContain('const ALLOWED = new Map([]);');
    expect(guard).not.toContain("'server/services/gmailHistorySync.service.ts',\n    'Gmail returns");
  });

  it('the sync no longer classifies by message text', () => {
    const src = readFileSync('server/services/gmailHistorySync.service.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toContain('e.message?.includes');
    expect(src).toContain("classified.kind === 'NOT_FOUND'");
  });
});
