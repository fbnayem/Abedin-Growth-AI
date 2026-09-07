import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';
import { config, isProduction } from '../config/environment';
import { verifiedPgOptions, describePlan, resolveTlsPlan } from './tls';

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

    // Both branches went out over `ssl: { rejectUnauthorized: false }` — any certificate from
    // anyone answering on the address, on every connection. This connection carries the
    // database password and, through `oauth_connections`, customers' plaintext Gmail access and
    // refresh tokens. `server/db/tls.ts` establishes and verifies the socket before pg writes a
    // byte to it, and THROWS if nothing is configured to verify against: an unverifiable server
    // is not a server this connects to.
    const url =
      config.dbUrl ??
      `postgresql://${encodeURIComponent(process.env.SQL_USER ?? '')}:` +
        `${encodeURIComponent(process.env.SQL_PASSWORD ?? '')}@` +
        `${process.env.SQL_HOST}:5432/${process.env.SQL_DB_NAME}`;
    const poolConfig = verifiedPgOptions(url);

    // Said once, at startup, because "pinned" and "verified against a CA" are different claims
    // and an operator reading a log should be able to tell which one this deployment is making.
    console.log('[db] ' + describePlan(resolveTlsPlan()));

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
