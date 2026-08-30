import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';
import { config, isProduction } from '../config/environment';

const { Pool } = pg;

declare global {
  var _postgresPool: pg.Pool | undefined;
}

export const createPool = () => {
  if (!global._postgresPool) {
    // If not production and no config provided, we might not have a DB yet. 
    // Wait for the environment variables.
    if (!config.dbUrl && !process.env.SQL_HOST) {
      if (isProduction) {
         console.warn("WARNING: No Database credentials provided in production.");
      }
      return null;
    }

    const poolConfig = config.dbUrl 
      ? { connectionString: config.dbUrl, ssl: { rejectUnauthorized: false } } 
      : {
          host: process.env.SQL_HOST,
          user: process.env.SQL_USER,
          password: process.env.SQL_PASSWORD,
          database: process.env.SQL_DB_NAME, ssl: { rejectUnauthorized: false },
        };

    global._postgresPool = new Pool({
      ...poolConfig,
      max: 10,
      connectionTimeoutMillis: 15000,
    });

    global._postgresPool.on('error', (err: any) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

const pool = createPool();

// If pool is null (e.g. dev without DB), we create a dummy proxy that throws if queried.
export const db = pool ? drizzle(pool, { schema }) : new Proxy({} as any, {
  get: () => {
    throw new Error("Database is not configured. Please provision PostgreSQL / Cloud SQL and set credentials.");
  }
});
