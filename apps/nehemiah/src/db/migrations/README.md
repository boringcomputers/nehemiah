# Control-plane migrations

Migrations are forward-only in production. Run `npm run migrate -w @nehemiah/nehemiah`
against a restored staging copy first, retain the pre-migration database snapshot, and
promote only after `/readyz` and the tenant-isolation smoke suite pass.

The migrator holds a PostgreSQL advisory lock on one session for the complete run and
stores a SHA-256 checksum for every applied file. A concurrent migrator fails safely,
and changing or removing a previously recorded migration stops deployment. Databases
created by the pre-checksum migrator are baselined once from the first upgraded build.

`0001_initial.sql` can be rolled back only before customer data exists by dropping the
Nehemiah database. After launch, corrective migrations must preserve the append-only
`machine_events`, `usage_events`, `audit_events`, `host_usage_observations`,
`meter_raw_usage_events`, `metering_exceptions`, and
`metering_exception_resolutions`, and `identity_provider_sync_receipts` ledgers;
never rewrite those rows. Exception
resolution is a new immutable row, never an update to the original evidence.
