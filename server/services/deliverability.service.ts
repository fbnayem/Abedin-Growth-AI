import { promises as dns } from 'node:dns';
import { store, collection, getDocs, query, where } from '../store';
import { isValidOrgId } from '../tenancy/orgScope';
import {
  evaluateSenderRecords,
  domainOfAddress,
  type DnsAnswer,
  type SenderPosture,
  type SenderRecords,
} from '../domain/senderIdentity';

/**
 * S27 — sender identity health for a tenant: which domain it sends from, and whether that domain
 * is set up to be believed.
 *
 * THE DOMAIN IS THE ONE THAT SENDS. The settings document carries a `senderEmail`, but it reaches
 * only prompts; every real send goes through the tenant's Gmail connection, so the domain judged
 * here is that connection's `accountEmail`. A tenant with no connection has no sending domain, and
 * that is reported as such — not as a domain that passed.
 *
 * THE RESOLVER IS THE ONLY THING THAT TOUCHES THE NETWORK. `resolveSenderRecords` asks DNS three
 * questions with a timeout each and turns every outcome into a `DnsAnswer`: NXDOMAIN and ENODATA
 * are ANSWERS (the record is not there), everything else is a FAILURE (we could not ask). The
 * evaluator in server/domain/senderIdentity.ts never sees an exception, and the difference
 * between "not there" and "could not ask" survives all the way to the gate.
 *
 * CACHED, BRIEFLY. DNS records change on the order of days; the gateway asks before every send.
 * A posture is kept for ten minutes per domain. A failed lookup is cached too — for one minute —
 * so a resolver outage does not turn every send into three timeouts, and does not stop being a
 * refusal either.
 */

const DKIM_SELECTORS_DEFAULT = ['google'];
const POSTURE_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;

export type TxtResolver = (name: string) => Promise<string[][]>;

/**
 * The resolver addresses to ask, or null for the system's. Node's `resolveTxt` goes through
 * c-ares to the servers in the OS configuration directly — not through `getaddrinfo` — and on a
 * host where that list is unusable (found live: a local stub at 127.0.0.1 refusing direct queries
 * while the OS resolver answered) every lookup is UNKNOWN and every send is refused, correctly and
 * with no way out. DNS_RESOLVERS is the way out: a comma-separated list of IPv4/IPv6 addresses.
 * A malformed entry is refused rather than silently dropped, so a typo cannot quietly fall back
 * to the resolvers that did not work.
 */
export function dnsResolvers(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.DNS_RESOLVERS;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const address = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)(?::\d{1,5})?$/;
  const bad = entries.filter((e) => !address.test(e));
  if (bad.length > 0) {
    throw new Error(`DNS_RESOLVERS must be a comma-separated list of resolver addresses; rejected: ${bad.join(', ')}`);
  }
  return entries.length > 0 ? entries : null;
}

/** The system resolver, or one pointed at DNS_RESOLVERS when set. Built once. */
let defaultResolver: TxtResolver | null = null;
export function systemTxtResolver(env: NodeJS.ProcessEnv = process.env): TxtResolver {
  if (defaultResolver !== null) return defaultResolver;
  const servers = dnsResolvers(env);
  if (servers === null) {
    defaultResolver = (name) => dns.resolveTxt(name);
  } else {
    const resolver = new dns.Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
    resolver.setServers(servers);
    defaultResolver = (name) => resolver.resolveTxt(name);
  }
  return defaultResolver;
}

/** Tests only: the built resolver is process-wide, and a test that sets DNS_RESOLVERS needs a fresh one. */
export function _resetResolverForTests(): void {
  defaultResolver = null;
}

/** The selectors to try at `<selector>._domainkey.<domain>`. Google Workspace's default is `google`. */
export function dkimSelectors(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DKIM_SELECTORS;
  if (typeof raw !== 'string' || raw.trim() === '') return DKIM_SELECTORS_DEFAULT;
  const selectors = raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]+$/.test(s));
  return selectors.length > 0 ? selectors : DKIM_SELECTORS_DEFAULT;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** One TXT lookup as an answer. Absence is an answer; a failure is a failure. */
export async function txtAnswer(name: string, resolver: TxtResolver): Promise<DnsAnswer> {
  try {
    const chunks = await withTimeout(resolver(name), LOOKUP_TIMEOUT_MS, `TXT ${name}`);
    return { ok: true, records: chunks.map((parts) => parts.join('')) };
  } catch (e: any) {
    const code = String(e?.code ?? '');
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { ok: true, records: [] };
    return { ok: false, error: `${code || 'lookup failed'}: ${String(e?.message ?? e)}` };
  }
}

export async function resolveSenderRecords(
  domain: string,
  selectors: string[] = dkimSelectors(),
  resolver: TxtResolver = systemTxtResolver()
): Promise<SenderRecords> {
  const [spf, dmarc, ...dkim] = await Promise.all([
    txtAnswer(domain, resolver),
    txtAnswer(`_dmarc.${domain}`, resolver),
    ...selectors.map((selector) => txtAnswer(`${selector}._domainkey.${domain}`, resolver)),
  ]);
  return { domain, spf, dmarc, dkim: selectors.map((selector, i) => ({ selector, answer: dkim[i] })) };
}

export interface CachedPosture {
  readonly posture: SenderPosture;
  readonly checkedAt: string;
  readonly cached: boolean;
}

const cache = new Map<string, { posture: SenderPosture; checkedAt: number }>();

/** Tests only. */
export function _resetPostureCacheForTests(): void {
  cache.clear();
}

export async function senderPostureFor(
  domain: string,
  now: number = Date.now(),
  resolver?: TxtResolver
): Promise<CachedPosture> {
  const hit = cache.get(domain);
  if (hit) {
    const ttl = hit.posture.verdict === 'UNKNOWN' ? FAILURE_TTL_MS : POSTURE_TTL_MS;
    if (now - hit.checkedAt < ttl) return { posture: hit.posture, checkedAt: new Date(hit.checkedAt).toISOString(), cached: true };
  }
  const records = await resolveSenderRecords(domain, dkimSelectors(), resolver);
  const posture = evaluateSenderRecords(records);
  cache.set(domain, { posture, checkedAt: now });
  return { posture, checkedAt: new Date(now).toISOString(), cached: false };
}

export type TenantSendingDomain =
  | { readonly ok: true; readonly domain: string; readonly accountEmail: string }
  | { readonly ok: false; readonly reason: string };

/** The domain the tenant actually sends from: its Gmail connection's account. */
export async function tenantSendingDomain(organizationId: string): Promise<TenantSendingDomain> {
  if (!isValidOrgId(organizationId)) return { ok: false, reason: 'No valid organisation id.' };
  if (!store) return { ok: false, reason: 'The datastore is unavailable, so the sending account cannot be read.' };
  try {
    const snap = await getDocs(query(collection(store, 'oauth_connections'), where('organizationId', '==', organizationId)));
    let accountEmail: string | null = null;
    snap.forEach((d) => {
      const data: any = d.data();
      if (String(data.provider ?? '').toLowerCase() !== 'gmail') return;
      if (typeof data.accountEmail === 'string' && data.accountEmail.length > 0) accountEmail = data.accountEmail;
    });
    if (accountEmail === null) return { ok: false, reason: 'No Gmail connection with an account email; this tenant has no sending domain.' };
    const domain = domainOfAddress(accountEmail);
    if (domain === null) return { ok: false, reason: `The connected account "${accountEmail}" has no usable domain.` };
    return { ok: true, domain, accountEmail };
  } catch (e: any) {
    return { ok: false, reason: `The sending account could not be read: ${String(e?.message ?? e)}` };
  }
}

export interface TenantDeliverability {
  readonly organizationId: string;
  readonly sendingDomain: TenantSendingDomain;
  readonly posture: CachedPosture | null;
  readonly dkimSelectors: string[];
  /** The resolvers asked: the system's, or DNS_RESOLVERS. An operator reading UNKNOWN needs this. */
  readonly resolvers: string[] | 'system';
  /** The two parts of deliverability this system cannot build, stated rather than omitted. */
  readonly bounces: string;
  readonly complaintFeedback: { readonly available: false; readonly reason: string };
}

export async function tenantDeliverability(organizationId: string, now: number = Date.now()): Promise<TenantDeliverability> {
  const sendingDomain = await tenantSendingDomain(organizationId);
  const posture = sendingDomain.ok ? await senderPostureFor(sendingDomain.domain, now) : null;
  return {
    organizationId,
    sendingDomain,
    posture,
    dkimSelectors: dkimSelectors(),
    resolvers: dnsResolvers() ?? 'system',
    bounces:
      'Handled as inbound mail (S28): a delivery status notification is classified from its headers, never its prose, ' +
      'and a permanent (5.x.x) bounce writes hardBounced, which the gateway refuses to send past.',
    complaintFeedback: {
      available: false,
      reason:
        'Gmail offers no per-sender complaint feed. Domain-level spam-rate reporting is Google Postmaster Tools, ' +
        'which needs the sending domain verified in that console and its API enabled — console work, not code.',
    },
  };
}
