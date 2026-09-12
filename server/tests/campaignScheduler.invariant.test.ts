import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enrolRecipientsSchema, contactTimeZoneSchema } from '../domain/apiContracts';
import { createContactSchema } from '../lib/validation';

/**
 * THE SCHEDULER IS OFF UNLESS SAID, AND A TICK NEVER OVERLAPS THE NEXT (S26).
 *
 * The loop is a production action loop, so it fails closed like the send flags: absent, blank
 * or anything but the exact string "true" leaves it stopped, with the reason recorded where the
 * on-demand tick can report it. Also here: the contracts that feed the engine refuse what it
 * would refuse — a time zone that is not a zone, an enrolment that names nothing.
 */

const ticks: { orgId: string; actor: string }[] = [];
let tickDelayMs = 0;
vi.mock('../services/campaignEngine.service', () => ({
  relationalConversationState: async () => null,
  runCampaignTick: async (orgId: string, _deps: unknown, _now: Date, actor: string) => {
    ticks.push({ orgId, actor });
    if (tickDelayMs > 0) await new Promise((r) => setTimeout(r, tickDelayMs));
    return { dispatched: [], refused: [], stopped: [], errors: [] };
  },
}));
vi.mock('../tenancy/organizations', () => ({ listServiceableOrgIds: async () => ['org-a', 'org-b'] }));

const ENV = ['CAMPAIGN_SCHEDULER_ENABLED', 'CAMPAIGN_TICK_INTERVAL_MS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  ticks.length = 0;
  tickDelayMs = 0;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
});

async function freshScheduler() {
  vi.resetModules();
  const mod = await import('../workers/campaignScheduler');
  return new mod.CampaignScheduler();
}

describe('1. off unless CAMPAIGN_SCHEDULER_ENABLED is exactly "true"', () => {
  for (const value of [undefined, '', 'TRUE', 'yes', '1', ' true']) {
    it(`does not start with ${JSON.stringify(value)}, and says why`, async () => {
      if (value === undefined) delete process.env.CAMPAIGN_SCHEDULER_ENABLED;
      else process.env.CAMPAIGN_SCHEDULER_ENABLED = value;
      const s = await freshScheduler();
      s.start();
      expect(s.isRunning).toBe(false);
      expect(s.disabledReason).toContain('CAMPAIGN_SCHEDULER_ENABLED');
      s.stop();
    });
  }

  it('THE INVARIANT — starts only with "true", ticks every serviceable organisation, and stops', async () => {
    process.env.CAMPAIGN_SCHEDULER_ENABLED = 'true';
    process.env.CAMPAIGN_TICK_INTERVAL_MS = '1000';
    vi.useFakeTimers();
    const s = await freshScheduler();
    s.start();
    expect(s.isRunning).toBe(true);
    expect(s.disabledReason).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks.map((t) => t.orgId)).toEqual(['org-a', 'org-b']);
    expect(ticks.every((t) => t.actor === 'scheduler')).toBe(true);
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toHaveLength(2);
    expect(s.isRunning).toBe(false);
  });

  it('a malformed interval is refused at load, not at the first tick', async () => {
    process.env.CAMPAIGN_TICK_INTERVAL_MS = 'soon';
    vi.resetModules();
    await expect(import('../config/environment')).rejects.toThrow(/CAMPAIGN_TICK_INTERVAL_MS/);
    process.env.CAMPAIGN_TICK_INTERVAL_MS = '500';
    vi.resetModules();
    await expect(import('../config/environment')).rejects.toThrow(/at least 1000/);
  });
});

describe('2. a tick in progress is not overlapped', () => {
  it('a second tickAll while the first is running returns without ticking again', async () => {
    delete process.env.CAMPAIGN_SCHEDULER_ENABLED;
    const s = await freshScheduler();
    tickDelayMs = 20;
    const first = s.tickAll();
    const second = s.tickAll();
    await Promise.all([first, second]);
    expect(ticks).toHaveLength(2); // two organisations, one pass — not four
    expect(s.lastTickAt).not.toBeNull();
  });
});

describe('3. the contracts refuse what the engine would refuse', () => {
  it('enrolment names one to five hundred contacts and nothing else', () => {
    expect(enrolRecipientsSchema.safeParse({ contactIds: ['a'] }).success).toBe(true);
    expect(enrolRecipientsSchema.safeParse({ contactIds: [] }).success).toBe(false);
    expect(enrolRecipientsSchema.safeParse({ contactIds: Array.from({ length: 501 }, (_, i) => `c${i}`) }).success).toBe(false);
    expect(enrolRecipientsSchema.safeParse({ contactIds: ['a'], sendNow: true }).success).toBe(false);
    expect(enrolRecipientsSchema.safeParse({}).success).toBe(false);
    expect(enrolRecipientsSchema.safeParse({ contactIds: [''] }).success).toBe(false);
  });

  it('a time zone is an IANA identifier: a fixed offset, a made-up zone or a blank is refused', () => {
    expect(contactTimeZoneSchema.safeParse({ timeZone: 'Europe/London' }).success).toBe(true);
    expect(contactTimeZoneSchema.safeParse({ timeZone: 'Asia/Dhaka', expectedVersion: 3 }).success).toBe(true);
    for (const bad of ['+06:00', 'Mars/Olympus', '', 'GMT+1', 'London']) {
      expect(contactTimeZoneSchema.safeParse({ timeZone: bad }).success, bad).toBe(false);
    }
    expect(contactTimeZoneSchema.safeParse({ timeZone: 'Europe/London', note: 'x' }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: 'a@b.example', timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: 'a@b.example', timeZone: 'Europe/Paris' }).success).toBe(true);
    expect(createContactSchema.safeParse({ email: 'a@b.example' }).success).toBe(true);
  });
});
