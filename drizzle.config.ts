import { defineConfig } from 'drizzle-kit';

/**
 * Schema changes run as a DIFFERENT role from the application.
 *
 * `MIGRATION_DATABASE_URL` is the owner; `DATABASE_URL` is the scoped runtime role the server
 * connects as. They are separate because a least-privilege application role should not hold
 * DDL rights — if the app can `DROP TABLE`, then so can anything that reaches the app.
 *
 * It falls back to DATABASE_URL so a local throwaway database with one superuser still works
 * without extra setup. The fallback is a convenience for development and not the shape
 * production should run in.
 */
export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL!,
    ssl: { rejectUnauthorized: false },
  },
});
