-- Privileges for the runtime application role.
--
-- Checked in rather than typed into a console, because a privilege model that lives only in
-- somebody's psql history cannot be reviewed, cannot be diffed, and cannot be reapplied after
-- the instance is rebuilt. This file is the answer to "what is the application allowed to do?"
--
-- Plain SQL only — no psql meta-commands (\set, \echo, \gexec). It has to be runnable both by
-- psql and by the node runner in scripts/db-apply.ts, and a file that only one of them can
-- execute is a file that stops being applied the moment the other is what is at hand.
--
-- Apply as the OWNER (MIGRATION_DATABASE_URL), AFTER migrations, never before: the GRANTs
-- below name tables, so a table that does not exist yet is not covered by them. The ALTER
-- DEFAULT PRIVILEGES section is what covers tables created later.
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/app-role-privileges.sql
--
-- ---------------------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------------------
-- Observed 2026-09-07 on growth-ai-abedin-747, connecting as the application role:
--
--     privileges: superuser=false  createdb=TRUE  createrole=TRUE
--     SELECT on public.contacts  -> DENIED
--
-- Backwards on both axes. The role could create databases and create roles — neither of which
-- an application ever needs — and could not read a single one of its own tables. A role with
-- CREATEROLE can grant itself membership of other roles, so "least privilege" was not a
-- description of it in any sense.
--
-- ---------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT GRANTED
-- ---------------------------------------------------------------------------------------
--   CREATE on schema public  — the application does not define its own tables; migrations do,
--                              as the owner. A role that can CREATE TABLE can also shadow one,
--                              and a shadowed table does not show up in a schema diff.
--   TRUNCATE                 — DELETE is bounded by a WHERE clause and by foreign keys.
--                              TRUNCATE is bounded by neither, and no code path in this
--                              repository needs it.
--   REFERENCES, TRIGGER      — both are schema changes wearing a data-privilege name.
--   Ownership of any table   — an owner may ALTER and DROP whatever the GRANTs say.

BEGIN;

-- 1. Take away what it should never have held. -------------------------------------------
ALTER ROLE "growth-ai-dat-user-747"
  NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS;

-- 2. Reach the data. ----------------------------------------------------------------------
GRANT CONNECT ON DATABASE "postgres" TO "growth-ai-dat-user-747";
GRANT USAGE ON SCHEMA public TO "growth-ai-dat-user-747";

-- Explicitly revoked rather than merely not granted: PostgreSQL 15 removed the implicit
-- CREATE-for-PUBLIC on the public schema, but an instance restored from an older dump can
-- still carry it, and a privilege inherited from a restore is exactly the kind nobody notices.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM "growth-ai-dat-user-747";

-- 3. Row-level access to the tables that exist now. ---------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO "growth-ai-dat-user-747";

-- Sequences back every serial and identity column. An INSERT without USAGE on the sequence
-- fails at runtime with a message naming the sequence rather than the missing grant.
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO "growth-ai-dat-user-747";

-- 4. And to the tables the NEXT migration creates. ----------------------------------------
--
-- Without this, every future migration silently produces tables the application cannot read,
-- and the failure appears later, at runtime, as "permission denied for table X" — long after
-- the migration reported success. FOR ROLE names the CREATOR: default privileges attach to the
-- role that creates the object, so this has to name the migration role, not the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "growth-ai-dat-user-747";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "growth-ai-dat-user-747";

COMMIT;
