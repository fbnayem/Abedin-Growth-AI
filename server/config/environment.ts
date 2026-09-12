export const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const config = {
  env: getEnv('NODE_ENV', 'development'),
  demoMode: getEnv('DEMO_MODE', 'false') === 'true',
  port: parseInt(getEnv('PORT', '3000'), 10),
  dbUrl: getEnv('DATABASE_URL', ''),
  gmailClientId: getEnv('GMAIL_CLIENT_ID', ''),
  gmailClientSecret: getEnv('GMAIL_CLIENT_SECRET', ''),
  gmailRedirectUri: getEnv('GMAIL_REDIRECT_URI', ''),
  geminiApiKey: getEnv('GEMINI_API_KEY', ''),
  redisUrl: getEnv('REDIS_URL', ''), // if using BullMQ
  secretKey: getEnv('SESSION_SECRET', 'super-secret-key-for-dev'),
};

export const isProduction = config.env === 'production';
export const isTest = config.env === 'test';
export const isDevelopment = config.env === 'development';

/**
 * S37 — per-tenant model spend ceilings, in USD cents (the provider's currency; see
 * server/policies/modelPricing.ts), per UTC day and per UTC month.
 *
 * The defaults are deliberately LOW — five dollars a day, fifty a month — so that a deployment
 * has to decide its budget rather than inherit an unbounded one. Zero is legal and means what
 * it says: no model spend. A malformed value refuses at startup, as PORT does, because a limit
 * that silently parsed to NaN would compare as never exceeded (§14).
 */
export interface TenantSpendLimits {
  readonly dailyCents: number;
  readonly monthlyCents: number;
}

function centsFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d{1,9}$/.test(raw.trim())) {
    throw new Error(
      `${key} must be a whole number of USD cents (0 or more); received ${JSON.stringify(raw)}.`
    );
  }
  return Number(raw.trim());
}

export function tenantSpendLimits(): TenantSpendLimits {
  return {
    dailyCents: centsFromEnv('TENANT_MODEL_SPEND_DAILY_LIMIT_CENTS', 500),
    monthlyCents: centsFromEnv('TENANT_MODEL_SPEND_MONTHLY_LIMIT_CENTS', 5000),
  };
}

// Evaluated once at load so a malformed limit stops the process here, not at the first reply.
tenantSpendLimits();

export interface CampaignSchedulerConfig {
  /** `CAMPAIGN_SCHEDULER_ENABLED` must be exactly "true". Absent, blank or anything else: off. */
  readonly enabled: boolean;
  readonly intervalMs: number;
}

/**
 * S26 — the campaign scheduler is a production action loop and defaults OFF, like every flag
 * that lets this system act on its own. A malformed interval is refused at load, not at the
 * first tick.
 */
export function campaignScheduler(): CampaignSchedulerConfig {
  const raw = process.env.CAMPAIGN_TICK_INTERVAL_MS;
  let intervalMs = 60_000;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1_000) {
      throw new Error(`CAMPAIGN_TICK_INTERVAL_MS must be an integer number of milliseconds, at least 1000; got ${JSON.stringify(raw)}.`);
    }
    intervalMs = n;
  }
  return { enabled: process.env.CAMPAIGN_SCHEDULER_ENABLED === 'true', intervalMs };
}

campaignScheduler();

if (isProduction && config.demoMode) {
  throw new Error("CRITICAL SAFETY ERROR: DEMO_MODE cannot be true in production!");
}
