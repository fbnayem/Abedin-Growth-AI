import { store } from '../store';
import { isRealActionEnabled } from '../config/safeMode';
import { fetchWithTimeout } from '../lib/httpClient';
import { classifyThrown, KIND_DISPOSITION } from '../lib/providerError';
import { checkCrawlTarget, type Resolver } from '../domain/crawlTarget';
import {
  parseRobots,
  robotsVerdict,
  ROBOTS_ALLOW_ALL,
  ROBOTS_DENY_ALL,
  type RobotsFile,
} from '../domain/robots';
import { companyNameFrom, extractPageFacts, type FoundAddress } from '../domain/pageExtraction';
import { validateCandidate } from '../domain/leadCandidate';
import { normaliseCountry, type AddressType, type LawfulBasis } from '../domain/lawfulBasis';
import { ingestRecords, type IngestMode, type IngestOutcome, type IngestRecord } from './leadIngest.service';
import type { ContactProvenance } from '../domain/contactDocument';
import type { Attribution } from '../domain/operatorAction';

/**
 * THE SCRAPE WORKER (§14, §18, §32, §A).
 *
 * Built in-house, and built so that the parts that could cause harm are the parts that are
 * hardest to get wrong by accident.
 *
 * WHAT MAKES A SCRAPER DANGEROUS, IN ORDER
 * ----------------------------------------
 * 1. WHERE IT FETCHES FROM. A server making requests to a URL somebody handed it is server-side
 *    request forgery. `checkCrawlTarget` refuses IP literals, private addresses, non-web ports
 *    and reserved names, and it RESOLVES THE NAME and checks the addresses, because a hostname
 *    is not a promise about an address. That check runs again on every page, not once per run:
 *    a link on page two is a new URL and gets the same scrutiny.
 *
 * 2. HOW HARD IT FETCHES. `robots.txt` decides what may be fetched; a per-host interval decides
 *    how often; a page budget decides when to stop. All three are enforced here rather than
 *    left to the caller, because the caller is a worker loop and a loop with no ceiling is how
 *    an address gets blocked.
 *
 * 3. WHAT IT DOES WITH WHAT IT READS (§18). Extraction returns structured facts and NOT the
 *    page's prose, so no block of somebody's website is stored on a contact where a future
 *    prompt could interpolate it. Nothing in this file calls a model. The facts then go through
 *    `validateCandidate` and `ingestRecords` — the same validator and the same write the CSV
 *    import and the paid provider use — so a page cannot set a suppression flag, nominate a
 *    lawful basis, or smuggle a spreadsheet formula into a company name.
 *
 * 4. WHETHER ANYONE MAY BE EMAILED AFTERWARDS. Nobody, yet. A scraped record carries legitimate
 *    interest at best and stays unmailable until the Article 14 notice is recorded as sent —
 *    which is the obligation that applies most clearly to data collected this way, since the
 *    person has no idea it happened.
 *
 * AND THE FLAG. `REAL_SCRAPE_ENABLED` is one of the seven production-action flags and fails
 * closed. Fetching somebody's website from this system's address, under this system's user
 * agent, is an effect in the world that deleting a row does not undo.
 */

/** Identifies this crawler in requests and in robots.txt. Honest rather than disguised. */
export const SCRAPE_USER_AGENT_TOKEN = 'AbedinGrowthBot';

export const SCRAPE_USER_AGENT =
  `${SCRAPE_USER_AGENT_TOKEN}/1.0 (+https://abedintech.com/bot; contact webmaster for removal)`;

/** Minimum gap between two requests to one host, when robots.txt does not ask for more. */
export const DEFAULT_CRAWL_DELAY_MS = 2_000;

/** The longest this worker will wait on a host's crawl-delay before giving up on the run. */
export const MAX_CRAWL_WAIT_MS = 30_000;

/** Pages fetched in one run, including the seed. Small on purpose. */
export const DEFAULT_PAGE_BUDGET = 5;

/** Every fetch is bounded. A scrape that hangs is a worker that stops. */
export const SCRAPE_TIMEOUT_MS = 10_000;

export type ScrapeRefusalCode =
  | 'SCRAPE_DISABLED'
  | 'ATTRIBUTION_REQUIRED'
  | 'STORE_UNAVAILABLE'
  | 'TARGET_REFUSED'
  | 'ROBOTS_DISALLOWED'
  | 'ROBOTS_UNREACHABLE'
  | 'CRAWL_DELAY_TOO_LONG'
  | 'COUNTRY_UNKNOWN'
  | 'NO_LIA'
  | 'NO_SOURCE_EVIDENCE'
  | 'FETCH_FAILED';

export interface ScrapeBatchSettings {
  readonly basis: LawfulBasis;
  readonly liaId?: string;
  /** Required: the gate refuses an unknown jurisdiction, and a page rarely states one. */
  readonly country: string;
  /** What this run is for. Required, and it is what an Article 14 notice has to say. */
  readonly sourceEvidence: string;
  readonly type?: 'LEAD' | 'INVESTOR' | 'PARTNER';
  /**
   * Whether to take addresses that look like a named individual as well as role addresses.
   * Defaults to role addresses only, which is the materially lower-risk half.
   */
  readonly includePersonalAddresses?: boolean;
}

export interface FetchedPage {
  readonly url: string;
  readonly status: number;
  readonly addressesFound: number;
  readonly note: string;
}

export interface ScrapeResult {
  readonly ok: true;
  readonly mode: IngestMode;
  readonly host: string;
  readonly batchId: string;
  readonly userAgent: string;
  readonly pages: readonly FetchedPage[];
  readonly skipped: readonly { readonly url: string; readonly code: string; readonly message: string }[];
  readonly rejected: readonly { readonly ref: string; readonly code: string; readonly message: string }[];
  readonly counts: {
    readonly wouldCreate: number;
    readonly created: number;
    readonly duplicates: number;
    readonly failed: number;
    readonly mailable: number;
  };
  readonly outcomes: readonly IngestOutcome[];
}

export type ScrapeOutcome =
  | ScrapeResult
  | { readonly ok: false; readonly code: ScrapeRefusalCode; readonly message: string };

/** Everything the worker reaches the outside world through, injected so a test needs no network. */
export interface ScrapeEnvironment {
  readonly fetch?: (url: string, options: { timeoutMs: number; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;
  readonly resolve?: Resolver;
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * When each host may next be requested.
 *
 * Module-level and in-process, which is the honest scope: one deployment, one crawler. It is
 * NOT a distributed rate limit, and a second instance would crawl at twice the rate. That is
 * written here rather than implied, because an in-memory limiter that everyone assumes is
 * global is the same defect as the in-memory API rate limiter this repository already records.
 */
const nextAllowedAt = new Map<string, number>();

/** Test seam. A rate limiter that remembers between tests makes every test after the first lie. */
export function _resetCrawlStateForTests(): void {
  nextAllowedAt.clear();
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultFetch = async (url: string, options: { timeoutMs: number; headers: Record<string, string> }) => {
  const response = await fetchWithTimeout(url, {
    timeoutMs: options.timeoutMs,
    headers: options.headers,
    redirect: 'manual',
  });
  return { status: response.status, text: () => response.text() };
};

function batchIdFor(host: string, startedAt: string): string {
  return `scrape_${host}_${startedAt.slice(0, 19).replace(/[:T]/g, '')}`.slice(0, 120);
}

/**
 * Scrape one site for published contact addresses.
 *
 * A "site" rather than "the web": the run starts at one URL, follows only same-host links whose
 * path looks like a contact or team page, and stops at the page budget. A crawler that follows
 * anything ends up somewhere nobody chose, and cannot be reasoned about at all.
 */
export async function scrapeSite(
  orgId: string,
  seedUrl: string,
  batch: ScrapeBatchSettings,
  by: Attribution,
  options: { mode: IngestMode; pageBudget?: number; now?: Date; env?: ScrapeEnvironment } = { mode: 'PREVIEW' }
): Promise<ScrapeOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }

  if (by.kind !== 'IDENTIFIED') {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Scraping needs an identified operator: ${by.why}. Requests go out under this system's ` +
        `own name, and the records it creates are about people who did not ask to be in it.`,
    };
  }
  const actor = by.actor;

  if (!isRealActionEnabled('REAL_SCRAPE_ENABLED')) {
    return {
      ok: false,
      code: 'SCRAPE_DISABLED',
      message:
        'Web scraping is disabled. REAL_SCRAPE_ENABLED is not set to "true", and it fails ' +
        'closed: an absent, empty or misspelled value means no request leaves this process. ' +
        'Fetching somebody else\'s site is an effect in the world that deleting a row does not undo.',
    };
  }

  const country = normaliseCountry(batch.country);
  if (country === null) {
    return {
      ok: false,
      code: 'COUNTRY_UNKNOWN',
      message:
        `A scrape run must state the jurisdiction it is collecting in (received ` +
        `${JSON.stringify(batch.country)}). A page almost never says, and the outreach gate ` +
        `refuses an unknown country, so a run without one collects records that cannot be used.`,
    };
  }

  if (typeof batch.sourceEvidence !== 'string' || batch.sourceEvidence.trim() === '') {
    return {
      ok: false,
      code: 'NO_SOURCE_EVIDENCE',
      message:
        'A scrape run needs to say what it is for. That text is what an Article 14 notice has ' +
        'to tell each person about where their data came from — and for data collected this ' +
        'way, they have no other way of knowing.',
    };
  }

  if (batch.basis === 'LEGITIMATE_INTEREST' && (typeof batch.liaId !== 'string' || batch.liaId.trim() === '')) {
    return {
      ok: false,
      code: 'NO_LIA',
      message:
        'Scraping on legitimate interest requires the id of the balancing assessment that ' +
        'covers this run. Collecting personal data from the web without the person\'s knowledge ' +
        'is exactly the case the assessment exists to weigh.',
    };
  }

  const env = options.env ?? {};
  const doFetch = env.fetch ?? defaultFetch;
  const wait = env.wait ?? defaultWait;
  const clock = env.now ?? (() => Date.now());

  const seed = await checkCrawlTarget(seedUrl, { resolve: env.resolve });
  if (seed.ok === false) {
    return { ok: false, code: 'TARGET_REFUSED', message: `${seed.code}: ${seed.message}` };
  }

  const headers = { 'User-Agent': SCRAPE_USER_AGENT, Accept: 'text/html,application/xhtml+xml' };
  const pages: FetchedPage[] = [];
  const skipped: { url: string; code: string; message: string }[] = [];
  const rejected: { ref: string; code: string; message: string }[] = [];

  /** Waits out this host's crawl delay, or reports that the wait would be unreasonable. */
  const respectRate = async (host: string, delayMs: number): Promise<string | null> => {
    const due = nextAllowedAt.get(host) ?? 0;
    const waitMs = due - clock();
    if (waitMs > MAX_CRAWL_WAIT_MS) {
      return `${host} asked for a gap of ${Math.round(waitMs / 1000)}s, longer than this run will wait.`;
    }
    if (waitMs > 0) await wait(waitMs);
    nextAllowedAt.set(host, clock() + delayMs);
    return null;
  };

  // robots.txt FIRST, before any page of the site is touched.
  let robots: RobotsFile;
  const robotsUrl = `https://${seed.host}/robots.txt`;
  const rateProblem = await respectRate(seed.host, DEFAULT_CRAWL_DELAY_MS);
  if (rateProblem !== null) {
    return { ok: false, code: 'CRAWL_DELAY_TOO_LONG', message: rateProblem };
  }
  try {
    const response = await doFetch(robotsUrl, { timeoutMs: SCRAPE_TIMEOUT_MS, headers });
    if (response.status === 404 || response.status === 410) {
      // ABSENT is not the same as UNREACHABLE. RFC 9309: no robots.txt means no restrictions.
      robots = ROBOTS_ALLOW_ALL;
    } else if (response.status >= 500 || response.status === 429) {
      // UNREACHABLE means assume complete disallow. Reading a 500 as "no rules" is how a
      // crawler hammers a site that is already struggling.
      robots = ROBOTS_DENY_ALL;
    } else if (response.status >= 400) {
      robots = ROBOTS_ALLOW_ALL;
    } else {
      robots = parseRobots(await response.text());
    }
  } catch (error) {
    const classified = classifyThrown(error, { provider: seed.host, operation: 'robots.txt' });
    void KIND_DISPOSITION[classified.kind];
    return {
      ok: false,
      code: 'ROBOTS_UNREACHABLE',
      message:
        `robots.txt for ${seed.host} could not be read (${classified.kind}). A site whose rules ` +
        `cannot be read is one whose rules are not known, and unknown is not permission.`,
    };
  }

  const startedAt = (options.now ?? new Date()).toISOString();
  const budget = Math.max(1, Math.min(options.pageBudget ?? DEFAULT_PAGE_BUDGET, 20));
  const queue: string[] = [seed.url];
  const visited = new Set<string>();
  const found = new Map<string, { address: FoundAddress; pageUrl: string; companyName: string | null }>();

  while (queue.length > 0 && pages.length < budget) {
    const pageUrl = queue.shift() as string;
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    // Re-checked per page. A link found on page one is a new URL, and a site that links to
    // `http://10.0.0.5/` would otherwise be pointing this system at its own network.
    const target = await checkCrawlTarget(pageUrl, { resolve: env.resolve });
    if (target.ok === false) {
      skipped.push({ url: pageUrl, code: target.code, message: target.message });
      continue;
    }

    const path = new URL(target.url).pathname + new URL(target.url).search;
    const verdict = robotsVerdict(robots, SCRAPE_USER_AGENT_TOKEN, path);
    if (!verdict.allowed) {
      skipped.push({
        url: target.url,
        code: 'ROBOTS_DISALLOWED',
        message: `robots.txt disallows ${path}${verdict.rule ? ` (rule: ${verdict.rule.pattern})` : ''}.`,
      });
      // The seed being disallowed ends the run: there is nothing to crawl.
      if (pages.length === 0 && queue.length === 0) {
        return {
          ok: false,
          code: 'ROBOTS_DISALLOWED',
          message: `robots.txt for ${target.host} disallows ${path}. Nothing was fetched beyond robots.txt itself.`,
        };
      }
      continue;
    }

    const delayMs = verdict.crawlDelaySeconds !== null
      ? Math.max(0, verdict.crawlDelaySeconds) * 1000
      : DEFAULT_CRAWL_DELAY_MS;
    const problem = await respectRate(target.host, delayMs);
    if (problem !== null) {
      skipped.push({ url: target.url, code: 'CRAWL_DELAY_TOO_LONG', message: problem });
      break;
    }

    let status: number;
    let html: string;
    try {
      const response = await doFetch(target.url, { timeoutMs: SCRAPE_TIMEOUT_MS, headers });
      status = response.status;
      html = status >= 200 && status < 300 ? await response.text() : '';
    } catch (error) {
      const classified = classifyThrown(error, { provider: target.host, operation: 'GET' });
      skipped.push({ url: target.url, code: classified.kind, message: classified.message });
      continue;
    }

    if (html === '') {
      pages.push({ url: target.url, status, addressesFound: 0, note: `No body read (status ${status}).` });
      continue;
    }

    const facts = extractPageFacts(html, target.url);
    const companyName = companyNameFrom(facts);
    let usable = 0;
    for (const address of facts.addresses) {
      if (address.addressType === 'PERSONAL' && batch.includePersonalAddresses !== true) {
        rejected.push({
          ref: address.email,
          code: 'PERSONAL_ADDRESS_EXCLUDED',
          message:
            'Looks like a named individual rather than a role address, and this run was not ' +
            'asked to collect those. A published info@ is a business contact; a person\'s ' +
            'address on a team page is a different category of personal data.',
        });
        continue;
      }
      if (!found.has(address.email)) {
        found.set(address.email, { address, pageUrl: target.url, companyName });
        usable++;
      }
    }

    pages.push({
      url: target.url,
      status,
      addressesFound: usable,
      note: facts.title === null ? 'No title.' : facts.title.slice(0, 120),
    });

    for (const link of facts.links) {
      if (!visited.has(link) && queue.length + pages.length < budget * 2) queue.push(link);
    }
  }

  // Candidates. Structured fields only — see the note in `pageExtraction` about why no prose
  // from the page is stored on a contact.
  const records: IngestRecord[] = [];
  for (const [email, hit] of found) {
    const outcome = validateCandidate({
      email,
      companyName: hit.companyName ?? undefined,
      companyWebsite: `https://${seed.host}/`,
      country,
      addressType: hit.address.addressType,
    });
    if (outcome.ok === false) {
      rejected.push({ ref: email, code: outcome.code, message: outcome.message });
      continue;
    }
    if (records.some((r) => r.contactId === outcome.candidate.contactId)) continue;
    records.push({
      ref: hit.pageUrl,
      email: outcome.candidate.email,
      contactId: outcome.candidate.contactId,
      fields: outcome.candidate.fields,
    });
  }

  const batchId = batchIdFor(seed.host, startedAt);
  const provenance: ContactProvenance = {
    source: `SCRAPE:${seed.host}`,
    sourceEvidence:
      `${batch.sourceEvidence} — collected from ${seed.host} on ${startedAt} by ` +
      `${SCRAPE_USER_AGENT_TOKEN}; pages: ${pages.map((p) => p.url).join(', ')}`,
    sourceCollectedAt: startedAt,
    importBatchId: batchId,
  };

  const result = await ingestRecords(
    orgId,
    records,
    {
      basis: batch.basis,
      liaId: batch.liaId,
      // No consent evidence and no consent source. A page being public is not an agreement to
      // be emailed, and recording one here would be inventing it.
      country,
    },
    provenance,
    actor,
    { mode: options.mode, type: batch.type ?? 'LEAD', now: options.now }
  );

  return {
    ok: true,
    mode: options.mode,
    host: seed.host,
    batchId,
    userAgent: SCRAPE_USER_AGENT,
    pages,
    skipped,
    rejected,
    counts: {
      wouldCreate: result.wouldCreate,
      created: result.created,
      duplicates: result.duplicates,
      failed: result.failed,
      mailable: result.mailable,
    },
    outcomes: result.outcomes,
  };
}
