/**
 * ROBOTS.TXT, HONOURED RATHER THAN MENTIONED (RFC 9309).
 *
 * The politeness rules are not decoration. They are the difference between a crawler a site
 * owner tolerates and one they block, and — since the scrape worker runs from this system's own
 * address under this system's own user agent — a block lands on the operator, not on a test rig.
 *
 * THE TWO DEFAULTS THAT ARE EASY TO GET WRONG
 * -------------------------------------------
 * A robots.txt that is ABSENT (404) means there are no restrictions. A robots.txt that is
 * UNREACHABLE (a 5xx, a timeout, a connection failure) means assume complete disallow. RFC 9309
 * says both, and the distinction matters: treating a 500 as "no rules" is how a crawler hammers
 * a site that is already struggling, and treating a 404 as "forbidden" makes the feature useless
 * on the majority of sites that have no robots.txt at all.
 *
 * This module does not fetch. It parses, and it decides. The fetch and its failure modes belong
 * to the worker, which is what lets every rule below be tested without a network.
 *
 * MATCHING
 * --------
 * Longest matching rule wins; on an equal-length tie, Allow beats Disallow. `*` matches any run
 * of characters and `$` anchors the end. Group selection prefers the most specific user-agent
 * token that matches, falling back to `*`.
 */

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /** Seconds between requests, where the site asked for one. */
  readonly crawlDelaySeconds: number | null;
}

export interface RobotsFile {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
}

/** An empty rule set: everything allowed. What an absent robots.txt means. */
export const ROBOTS_ALLOW_ALL: RobotsFile = Object.freeze({ groups: [], sitemaps: [] });

/** A rule set that forbids everything. What an UNREACHABLE robots.txt means. */
export const ROBOTS_DENY_ALL: RobotsFile = Object.freeze({
  groups: [Object.freeze({ agents: ['*'], rules: [Object.freeze({ allow: false, pattern: '/' })], crawlDelaySeconds: null })],
  sitemaps: [],
});

/** Longest text this module will parse. A robots.txt larger than this is not a rule set. */
export const MAX_ROBOTS_BYTES = 512_000;

export function parseRobots(text: unknown): RobotsFile {
  if (typeof text !== 'string') return ROBOTS_ALLOW_ALL;
  const body = text.length > MAX_ROBOTS_BYTES ? text.slice(0, MAX_ROBOTS_BYTES) : text;

  const groups: { agents: string[]; rules: RobotsRule[]; crawlDelaySeconds: number | null }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: RobotsRule[]; crawlDelaySeconds: number | null } | null = null;
  // Consecutive `User-agent:` lines share one group; a rule line closes the run.
  let collectingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents || current === null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }

    // Any other directive ends the run of user-agent lines.
    collectingAgents = false;
    if (current === null) continue;

    if (field === 'allow' || field === 'disallow') {
      // `Disallow:` with an empty value allows everything, and is not a rule about "".
      if (field === 'disallow' && value === '') continue;
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
      continue;
    }

    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }

  return { groups, sitemaps };
}

/**
 * The group that governs this user agent.
 *
 * The most specific matching token wins: a group naming `abedingrowthbot` beats one naming `*`.
 * Matching is the substring test RFC 9309 specifies, case-insensitively.
 */
export function groupFor(robots: RobotsFile, userAgent: string): RobotsGroup | null {
  const agent = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLength = -1;

  for (const group of robots.groups) {
    for (const token of group.agents) {
      const specificity = token === '*' ? 0 : token.length;
      const matches = token === '*' || agent.includes(token);
      if (matches && specificity > bestLength) {
        best = group;
        bestLength = specificity;
      }
    }
  }
  return best;
}

/** Does a robots pattern match a path? `*` is any run, `$` anchors the end. */
export function patternMatches(pattern: string, path: string): boolean {
  let p = 0;
  let anchored = false;
  let source = pattern;
  if (source.endsWith('$')) {
    anchored = true;
    source = source.slice(0, -1);
  }

  const segments = source.split('*');
  // The first segment must match at the start.
  if (!path.startsWith(segments[0])) return false;
  p = segments[0].length;

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '') {
      if (i === segments.length - 1) return anchored ? false : true;
      continue;
    }
    const at = path.indexOf(segment, p);
    if (at < 0) return false;
    p = at + segment.length;
  }

  return anchored ? p === path.length : true;
}

export interface RobotsVerdict {
  readonly allowed: boolean;
  /** The rule that decided, for the report. Null when no rule matched. */
  readonly rule: RobotsRule | null;
  readonly crawlDelaySeconds: number | null;
}

/**
 * May this path be fetched?
 *
 * The path is the request target — everything after the host, query string included, because
 * robots patterns are matched against it.
 */
export function robotsVerdict(robots: RobotsFile, userAgent: string, path: string): RobotsVerdict {
  const group = groupFor(robots, userAgent);
  if (group === null) return { allowed: true, rule: null, crawlDelaySeconds: null };

  let decision: RobotsRule | null = null;
  let decisionLength = -1;

  for (const rule of group.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.replace(/[*$]/g, '').length;
    // Longest wins. On a tie, Allow beats Disallow — the standard's rule, and the one that
    // makes `Disallow: /` plus `Allow: /public/` mean what a site owner intends.
    if (length > decisionLength || (length === decisionLength && rule.allow && decision !== null && !decision.allow)) {
      decision = rule;
      decisionLength = length;
    }
  }

  return {
    allowed: decision === null ? true : decision.allow,
    rule: decision,
    crawlDelaySeconds: group.crawlDelaySeconds,
  };
}
