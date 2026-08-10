\set ON_ERROR_STOP on

\if :{?runtime_role}
\else
  \set runtime_role nehemiah_app
\endif
\if :{?migration_role}
\else
  \set migration_role nehemiah_migrator
\endif

-- Run this once as the dedicated database administrator. Passwords are set by
-- the provider/secret manager and are deliberately not accepted by this file.
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'migration_role'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migration_role') \gexec
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'runtime_role'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role') \gexec

SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'migration_role') \gexec
SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'runtime_role') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'migration_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migration_role') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role') \gexec

-- Repair an older installation which followed the pre-split deployment guide
-- and consequently created schema objects as the application role. The
-- database is required to be dedicated to Nehemiah before this is run.
SELECT format('REASSIGN OWNED BY %I TO %I', :'runtime_role', :'migration_role') \gexec

