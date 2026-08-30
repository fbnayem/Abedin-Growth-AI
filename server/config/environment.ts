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

if (isProduction && config.demoMode) {
  throw new Error("CRITICAL SAFETY ERROR: DEMO_MODE cannot be true in production!");
}
