-- Privileges for the runtime application role.
--
-- Checked in rather than typed into a console, because a privilege model that lives only in
-- somebody's psql history cannot be reviewed, cannot be diffed, and cannot be reapplied after
-- the instance is rebuilt. This file is the answer to "what is the application allowed to do?"
--
-- Apply as the OWNER (MIGRATION_DATABASE_URL), after migrations, not before: the GRANTs below
-- name tables, so tables that do not exist yet are not covered. The ALTER DEFAULT PRIVILEGES
-- section is what covers the ones created later.
--
--   psql "$MIGRATION_DATABASE_URL" -f scripts/sql/app-role-privileges.sql
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
-- an application ever needs — and could not read a single one of its own tables. A role that
-- can CREATEROLE can grant itself membership of other roles, so "least privilege" was not a
-- description of it in any sense.
--
-- ---------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT GRANTED
-- ---------------------------------------------------------------------------------------
--   CREATE on schema public  — the application does not define its own tables. Migrations do,
--                              as the owner. If the app can CREATE TABLE it can also shadow
--                              one, and a shadowed table is invisible in a schema diff.
--   TRUNCATE                 — DELETE is bounded by a WHERE clause and by foreign keys.
--                              TRUNCATE is neither, and no code path in this repository needs
--                              it. S6's transition maps assume rows are deleted individually.
--   REFERENCES, TRIGGER      — both are schema changes wearing a data-privilege name.
--   Ownership of any table   — an owner can ALTER and DROP regardless of GRANTs.

\set ON_ERROR_STOP on

-- The role this applies to. Quoted because it contains hyphens.
\set app_role '"growth-ai-dat-user-747"'

BEGIN;

-- 1. Take away what it should never have held. -------------------------------------------
ALTER ROLE :app_role NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS;

-- 2. Reach the data. ----------------------------------------------------------------------
GRANT CONNECT ON DATABASE postgres TO :app_role;
GRANT USAGE ON SCHEMA public TO :app_role;

-- Explicitly revoked rather than merely not granted: PostgreSQL 15 removed the implicit
-- CREATE-for-PUBLIC on the public schema, but an instance restored from an older dump can
-- still carry it, and inheriting a privilege from a restore is exactly the kind of thing
-- nobody notices.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM :app_role;

-- 3. Row-level access to the tables that exist now. ---------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :app_role;

-- Sequences back every serial/identity column; INSERT without USAGE on the sequence fails at
-- runtime with a message that points at the sequence rather than at the missing grant.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :app_role;

-- 4. And to the tables the NEXT migration creates. ----------------------------------------
--
-- Without this, every future migration silently produces tables the application cannot read,
-- and the failure appears later, at runtime, as "permission denied for table X" — long after
-- the migration reported success. FOR ROLE names the creator: default privileges attach to
-- the role that creates the object, so this must name the migration role.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :app_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :app_role;

COMMIT;

-- 5. Prove it, rather than assume it. -----------------------------------------------------
--
-- A GRANT that ran without error is not evidence the role can read the table: the grant may
-- have named a role that does not exist in the way you think, or a schema the table is not in.
-- These select the actual catalogue state.
\echo ''
\echo '--- role attributes (all four should be false) ---'
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
  FROM pg_roles WHERE rolname = 'growth-ai-dat-user-747';

\echo ''
\echo '--- tables the app role can read, and any it cannot ---'
SELECT
  count(*) FILTER (WHERE has_table_privilege('growth-ai-dat-user-747', c.oid, 'SELECT')) AS can_select,
  count(*) FILTER (WHERE NOT has_table_privilege('growth-ai-dat-user-747', c.oid, 'SELECT')) AS cannot_select,
  count(*) FILTER (WHERE has_table_privilege('growth-ai-dat-user-747', c.oid, 'TRUNCATE')) AS can_truncate_should_be_0
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND n.nspname = 'public'
   AND c.relname NOT LIKE 'google_db_advisor%'
   AND c.relname NOT LIKE 'hypopg%';

\echo ''
\echo '--- the app role must NOT be able to create tables ---'
SELECT has_schema_privilege('growth-ai-dat-user-747', 'public', 'CREATE') AS can_create_should_be_false;
