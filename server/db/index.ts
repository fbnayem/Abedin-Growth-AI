import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
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

/**
 * P1.2 — The export is TYPED, and that is the change that matters here.
 *
 * It used to read `pool ? drizzle(...) : new Proxy({} as any, ...)`. The two branches form a
 * union with `any`, and a union containing `any` collapses to `any` — so every Drizzle call in
 * the repository was unchecked. `db.insert(messages).values({})` type-checked. Omitting a NOT
 * NULL column type-checked. Selecting a column that does not exist type-checked.
 *
 * That is why adding organization_id to thirteen tables initially produced zero compiler
 * errors at the call sites that fail to populate it: nothing was doing the checking. With the
 * proxy asserted to the real database type, the schema constrains the code again.
 *
 * If pool is null (dev without a database) the proxy still throws on any property access; the
 * assertion changes what the compiler knows, not what happens at runtime.
 */
export const db: NodePgDatabase<typeof schema> = pool
  ? drizzle(pool, { schema })
  : (new Proxy({} as any, {
      get: () => {
        throw new Error("Database is not configured. Please provision PostgreSQL / Cloud SQL and set credentials.");
      },
    }) as NodePgDatabase<typeof schema>);
