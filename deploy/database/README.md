# Nehemiah PostgreSQL

Use a dedicated PostgreSQL 16+ database for each environment. Neon is the beta
default, but the control plane uses the ordinary PostgreSQL protocol and does not
depend on provider-specific APIs.

Provision two roles once, from an administrator connection to the dedicated
database. The SQL is idempotent and accepts environment-specific role names;
it never accepts or prints passwords:

```bash
psql "$ADMIN_DATABASE_URL" \
  -v runtime_role=nehemiah_app \
  -v migration_role=nehemiah_migrator \
  -f deploy/database/provision-roles.sql
```

Set independent passwords through the database provider or an interactive
`psql` session, store both URLs in the deployment secret manager, and give the
long-running service only `DATABASE_URL`. Give the one-shot migration job both
`DATABASE_URL` and `MIGRATION_DATABASE_URL`; the migrator rejects a shared role
in production and reapplies the least-privilege grants after every migration.
Both production URLs must use `sslmode=verify-full`; encrypted transport without
certificate/hostname verification is rejected.
Use the separate `deploy/environments/*-migration.env.example` templates for
that job; the runtime templates intentionally contain no migration credential.

Before promotion:

1. Restore the latest backup into an isolated database.
2. Run `npm run migrate -w @nehemiah/nehemiah` against that copy.
3. Run control-plane health and tenant-isolation tests.
4. Snapshot production, run the same migration once, then deploy compatible code.

The runtime role has DML access but cannot own tables, mutate migration metadata,
alter/disable triggers, or update/delete/truncate the append-only `machine_events`,
`usage_events`, and `audit_events` ledgers. Keep the migration URL out of the
runtime workload entirely. Database URLs are secrets and must never enter an image,
repository, log, or preview environment.
