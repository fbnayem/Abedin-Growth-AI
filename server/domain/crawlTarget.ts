/**
 * WHICH URLS THIS SYSTEM IS WILLING TO FETCH (§18, §A).
 *
 * A scraper takes a URL from an operator, or from a link on a page it already fetched, and asks
 * the server to make a request to it. That is server-side request forgery in the ordinary case,
 * not the exotic one: the request goes out from inside the deployment's network, with whatever
 * that network can reach.
 *
 * THE THINGS THAT ACTUALLY GET REACHED
 * ------------------------------------
 * `http://169.254.169.254/` is the cloud metadata endpoint on AWS, Azure and GCP; on an
 * unhardened instance it hands out credentials to anyone who asks. `http://127.0.0.1:5432` is
 * the database. `http://10.0.0.5:6379` is whatever else is in the VPC. None of these needs an
 * attacker to be clever — an operator pasting a URL they were sent is enough.
 *
 * THE DEFENCE IS IN TWO PARTS, AND BOTH ARE NECESSARY
 * ---------------------------------------------------
 * 1. THE URL ITSELF: http(s) only, on the standard ports, with no credentials, and a hostname
 *    that is a real public-looking name rather than an IP literal or a single label.
 *
 * 2. WHERE THE NAME RESOLVES. A hostname is not a promise about an address.
 *    `metadata.attacker.example` can have an A record pointing at 169.254.169.254, and every
 *    check in part 1 passes. So the name is resolved and the ADDRESS is checked, which is the
 *    part that is usually missing.
 *
 * WHAT THIS STILL DOES NOT CLOSE, STATED PLAINLY
 * ----------------------------------------------
 * DNS rebinding. Between the check here and the socket the runtime opens, the name can be
 * re-resolved to a different address, and nothing short of pinning the checked address into the
 * connection closes that. It is a real gap, it is narrow, and it is written down here rather
 * than left to be discovered. The mitigations that are in place — a small page budget, no
 * redirects followed to a new host without re-checking, and the whole feature being off by
 * default — bound what it could reach rather than preventing it.
 */

import { lookup } from 'node:dns/promises';

export type TargetRefusalCode =
  | 'BAD_URL'
  | 'BAD_SCHEME'
  | 'BAD_PORT'
  | 'CREDENTIALS_IN_URL'
  | 'IP_LITERAL'
  | 'RESERVED_NAME'
  | 'UNRESOLVABLE'
  | 'PRIVATE_ADDRESS';

export type TargetVerdict =
  | { readonly ok: true; readonly url: string; readonly host: string; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly code: TargetRefusalCode; readonly message: string };

/** Ports a web page is served on. Anything else is a service, not a site. */
const ALLOWED_PORTS = new Set(['', '80', '443']);

/**
 * Host suffixes and names that never belong to a public web site.
 *
 * `.local` and `.internal` are the common private-network suffixes; `localhost` is itself; a
 * single-label name such as `intranet` resolves through a search domain to something inside.
 */
const RESERVED_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa', '.lan'];

/** Is this text an IP address rather than a name? */
export function isIpLiteral(host: string): boolean {
  if (/^\[.*\]$/.test(host)) return true; // bracketed IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // A bare IPv6 without brackets, and the decimal/hex forms of IPv4 that still route.
  if (host.includes(':')) return true;
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) return true;
  if (/^\d+$/.test(host)) return true;
  return false;
}

/**
 * Is this address one that must never be fetched from a server?
 *
 * Written out per range rather than pulled from a library, because each line is a decision
 * somebody should be able to check, and because "is this address private" has more answers
 * than the three everybody remembers.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();

  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1 — the mapping is not a disguise.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);

  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // fe80::/10 link local
    if (/^ff[0-9a-f]{2}:/.test(ip)) return true; // multicast
    return false;
  }

  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link local — the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments, incl. 192.0.0.0/24
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Injected so a test does not depend on DNS, and so a sandbox without a resolver can run. */
export type Resolver = (host: string) => Promise<readonly string[]>;

export const systemResolver: Resolver = async (host) => {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
};

/**
 * May this URL be fetched?
 *
 * Returns the NORMALISED url, which is what the caller should actually request: the input is
 * re-serialised from the parsed form, so a URL that parses one way here and another way in the
 * fetch implementation cannot differ.
 */
export async function checkCrawlTarget(
  raw: unknown,
  options: { resolve?: Resolver } = {}
): Promise<TargetVerdict> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, code: 'BAD_URL', message: 'No URL was given.' };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'BAD_URL', message: `${JSON.stringify(raw)} is not a URL.` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'BAD_SCHEME',
      message:
        `Only http and https are fetched; ${JSON.stringify(url.protocol)} is not. file:, ` +
        `gopher: and ftp: are the schemes that turn a fetcher into a file reader.`,
    };
  }

  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      code: 'CREDENTIALS_IN_URL',
      message:
        'The URL carries credentials. A scraper sending a username and password to a site it ' +
        'was pointed at is a way to leak them, not a way to authenticate.',
    };
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return {
      ok: false,
      code: 'BAD_PORT',
      message: `Port ${url.port} is not a web port. A page is served on 80 or 443; anything else is a service.`,
    };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  if (isIpLiteral(host) || isIpLiteral(url.hostname)) {
    return {
      ok: false,
      code: 'IP_LITERAL',
      message:
        `${JSON.stringify(url.hostname)} is an address rather than a name. A public web site ` +
        `has a name, and an address here is how the metadata endpoint gets reached.`,
    };
  }

  if (!host.includes('.') || RESERVED_SUFFIXES.some((s) => host.endsWith(s)) || host === 'localhost') {
    return {
      ok: false,
      code: 'RESERVED_NAME',
      message:
        `${JSON.stringify(host)} is not a public hostname. Single-label names resolve through ` +
        `a search domain to something inside the network, and .local, .internal and .lan are ` +
        `private by definition.`,
    };
  }

  const resolve = options.resolve ?? systemResolver;
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch (e: unknown) {
    return {
      ok: false,
      code: 'UNRESOLVABLE',
      message: `${host} could not be resolved (${String((e as { message?: unknown })?.message ?? e)}).`,
    };
  }

  if (addresses.length === 0) {
    return { ok: false, code: 'UNRESOLVABLE', message: `${host} resolved to no addresses.` };
  }

  // EVERY address, not the first. A name with one public A record and one pointing at
  // 127.0.0.1 is a name that will eventually be connected to on the second.
  const priv = addresses.find((a) => isPrivateAddress(a));
  if (priv !== undefined) {
    return {
      ok: false,
      code: 'PRIVATE_ADDRESS',
      message:
        `${host} resolves to ${priv}, which is inside a private or reserved range. A public ` +
        `name pointing at a private address is the ordinary way a scraper is turned into a ` +
        `client for the network it runs in.`,
    };
  }

  return { ok: true, url: url.toString(), host, addresses };
}
