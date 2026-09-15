/**
 * READING A COMPANY PAGE, WITHOUT LETTING IT READ BACK (§18).
 *
 * WHAT THIS EXTRACTS AND WHAT IT DELIBERATELY DOES NOT
 * ----------------------------------------------------
 * Structured facts: role addresses, the page title, the company name where the page states one,
 * and links worth following. NOT the page's prose.
 *
 * That omission is the important decision. The obvious design stores a paragraph of the
 * company's "About" page on the contact as `notes`, which is genuinely useful — and creates a
 * free-text field, containing attacker-controlled text, on a record that a future feature will
 * interpolate into a prompt. §18 is easier to keep by not creating the hazard than by
 * remembering to fence it every time. What the operator sees of the page is in the run report,
 * which is read by a person and stored nowhere.
 *
 * ADDRESSES FOUND ON A PAGE ARE ROLE ADDRESSES, AND THAT IS A CLAIM WORTH BEING CAREFUL WITH
 * -----------------------------------------------------------------------------------------
 * `info@`, `hello@` and `contact@` published on a company's own contact page are about as close
 * to a business address as this system can get without a person confirming it. A named
 * individual's address found in an author byline is a different thing, and this module reports
 * which it thinks each is rather than deciding. The lawful-basis gate then makes the decision,
 * where the rule already lives.
 *
 * NO HTML PARSER
 * --------------
 * Deliberately regex over a size-capped string, with script and style removed first. A parser
 * would be more accurate and would also be a dependency that processes hostile input on the
 * server. What is extracted here is narrow enough that the accuracy is not the constraint.
 */

/** The most HTML this module will look at. A page larger than this is not a contact page. */
export const MAX_PAGE_BYTES = 1_000_000;

/** The most addresses taken from any one page, so a directory page cannot become an import. */
export const MAX_ADDRESSES_PER_PAGE = 25;

/** The most links followed out of any one page. */
export const MAX_LINKS_PER_PAGE = 40;

/**
 * Local parts that are a role rather than a person.
 *
 * Used to LABEL, never to decide: the label goes onto the record as `addressType`, and the
 * lawful-basis gate decides what that means.
 */
const ROLE_LOCAL_PARTS = new Set([
  'info', 'hello', 'contact', 'enquiries', 'enquiry', 'inquiries', 'sales', 'support', 'admin',
  'office', 'reception', 'team', 'mail', 'email', 'help', 'bookings', 'booking', 'appointments',
  'general', 'practice', 'reservations', 'hi', 'ask', 'press', 'media', 'marketing', 'accounts',
]);

/** Addresses that are never a lead: image and asset filenames that look like addresses, etc. */
const NEVER_A_LEAD = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico)$/i;

export interface FoundAddress {
  readonly email: string;
  readonly addressType: 'ROLE' | 'PERSONAL';
  /** Whether it came from a `mailto:` link, which is a stronger signal than text on the page. */
  readonly fromMailto: boolean;
}

export interface PageFacts {
  readonly title: string | null;
  /** The organisation name where the page states one, from og:site_name or the title. */
  readonly siteName: string | null;
  readonly addresses: readonly FoundAddress[];
  /** Same-host links worth following, already absolute and de-duplicated. */
  readonly links: readonly string[];
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function classify(email: string): FoundAddress['addressType'] {
  const local = email.slice(0, email.indexOf('@')).toLowerCase();
  const base = local.split('+')[0].replace(/[._-]?\d+$/, '');
  return ROLE_LOCAL_PARTS.has(base) ? 'ROLE' : 'PERSONAL';
}

/** Paths that usually carry contact details. Following everything is neither polite nor useful. */
const WORTH_FOLLOWING = /\/(contact|contact-us|about|about-us|team|our-team|people|staff|impressum|kontakt|meet-the-team|leadership)\/?$/i;

/**
 * Pull the facts out of one page.
 *
 * `pageUrl` is used to resolve relative links and to keep link discovery on the same host. A
 * scraper that follows off-host links is a scraper that will end up somewhere nobody chose.
 */
export function extractPageFacts(html: unknown, pageUrl: string): PageFacts {
  if (typeof html !== 'string' || html === '') {
    return { title: null, siteName: null, addresses: [], links: [] };
  }
  const capped = html.length > MAX_PAGE_BYTES ? html.slice(0, MAX_PAGE_BYTES) : html;

  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return { title: null, siteName: null, addresses: [], links: [] };
  }

  const titleMatch = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(capped);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null;

  const siteNameMatch = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,200})["']/i.exec(capped);
  const siteName = siteNameMatch ? decodeEntities(siteNameMatch[1]).trim() || null : null;

  // mailto: links first — an address a site published as a link is a stronger signal than one
  // that merely appears in text, which could be a customer's address quoted in a testimonial.
  const seen = new Map<string, FoundAddress>();
  const mailtoPattern = /href\s*=\s*["']\s*mailto:([^"'?\s>]{3,320})/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoPattern.exec(capped)) !== null && seen.size < MAX_ADDRESSES_PER_PAGE) {
    const email = decodeEntities(m[1]).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(email) || NEVER_A_LEAD.test(email)) continue;
    if (!seen.has(email)) seen.set(email, { email, addressType: classify(email), fromMailto: true });
  }

  const text = decodeEntities(stripTags(capped));
  const bare = text.match(EMAIL_PATTERN) ?? [];
  for (const raw of bare) {
    if (seen.size >= MAX_ADDRESSES_PER_PAGE) break;
    const email = raw.trim().toLowerCase();
    if (NEVER_A_LEAD.test(email)) continue;
    if (!seen.has(email)) seen.set(email, { email, addressType: classify(email), fromMailto: false });
  }

  const links = new Set<string>();
  const hrefPattern = /href\s*=\s*["']([^"'>\s]{1,500})["']/gi;
  while ((m = hrefPattern.exec(capped)) !== null && links.size < MAX_LINKS_PER_PAGE) {
    let candidate: URL;
    try {
      candidate = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    if (candidate.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') continue;
    candidate.hash = '';
    if (!WORTH_FOLLOWING.test(candidate.pathname)) continue;
    links.add(candidate.toString());
  }

  return { title, siteName, addresses: [...seen.values()], links: [...links] };
}

/**
 * A company name for a page, from what the page says about itself.
 *
 * Titles are usually `Contact Us | Harley Dental` or `Harley Dental - Contact`. The longest
 * segment that is not a generic page name is the best available guess, and where there is no
 * good answer this returns null rather than a bad one — a wrong company name on nine hundred
 * records is worse than none, and the scorer treats absent as not-scored rather than as zero.
 */
export function companyNameFrom(facts: PageFacts): string | null {
  if (facts.siteName !== null && facts.siteName.length >= 2) return facts.siteName;
  if (facts.title === null) return null;

  const generic = /^(home|contact|contact us|about|about us|our team|team|people|staff|welcome|impressum|kontakt)$/i;
  const segments = facts.title
    .split(/[|–—·:]|\s-\s/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !generic.test(s));

  if (segments.length === 0) return null;
  return segments.reduce((longest, s) => (s.length > longest.length ? s : longest), segments[0]);
}
