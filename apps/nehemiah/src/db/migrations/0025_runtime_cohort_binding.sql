-- A built-in source name is not an immutable machine source. Bind every
-- enrolled host and every assigned machine to the exact signed runtime cohort
-- (VMM, jailer, kernel, and both built-in root filesystems).
--
-- Managed volumes are production-disabled in this release. Refuse an upgrade
-- that would strand an older volume/object/deletion commitment without its
-- cleanup worker; an operator must finish that retention workflow first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM volumes)
     OR EXISTS (SELECT 1 FROM volume_write_grant_reservations)
     OR EXISTS (SELECT 1 FROM volume_deletion_jobs) THEN
    RAISE EXCEPTION
      'runtime cohort rollout requires the unsupported managed-volume surface to be empty';
  END IF;

  IF EXISTS (
    SELECT 1 FROM machines
    WHERE state IN ('starting', 'running', 'stopping')
  ) THEN
    RAISE EXCEPTION
      'runtime cohort rollout requires every assigned machine to be terminal';
  END IF;
END
$$;

ALTER TABLE host_enrollment_grants
  ADD COLUMN runtime_cohort_id text,
  ADD COLUMN runtime_contract_version integer,
  ADD COLUMN runtime_arch text,
  ADD COLUMN runtime_kernel_sha256 text,
  ADD COLUMN runtime_firecracker_sha256 text,
  ADD COLUMN runtime_jailer_sha256 text,
  ADD COLUMN runtime_python_rootfs_sha256 text,
  ADD COLUMN runtime_desktop_rootfs_sha256 text,
  ADD CONSTRAINT host_enrollment_runtime_cohort_check CHECK (
    (
      runtime_cohort_id IS NULL
      AND runtime_contract_version IS NULL
      AND runtime_arch IS NULL
      AND runtime_kernel_sha256 IS NULL
      AND runtime_firecracker_sha256 IS NULL
      AND runtime_jailer_sha256 IS NULL
      AND runtime_python_rootfs_sha256 IS NULL
      AND runtime_desktop_rootfs_sha256 IS NULL
    ) OR (
      runtime_cohort_id ~ '^[0-9a-f]{64}$'
      AND runtime_contract_version = 4
      AND runtime_arch IN ('amd64', 'arm64')
      AND runtime_arch = CASE architecture WHEN 'x86_64' THEN 'amd64' ELSE 'arm64' END
      AND runtime_kernel_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_firecracker_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_jailer_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_python_rootfs_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_desktop_rootfs_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE hosts
  ADD COLUMN runtime_cohort_id text,
  ADD COLUMN runtime_contract_version integer,
  ADD COLUMN runtime_arch text,
  ADD COLUMN runtime_kernel_sha256 text,
  ADD COLUMN runtime_firecracker_sha256 text,
  ADD COLUMN runtime_jailer_sha256 text,
  ADD COLUMN runtime_python_rootfs_sha256 text,
  ADD COLUMN runtime_desktop_rootfs_sha256 text,
  ADD CONSTRAINT hosts_runtime_cohort_check CHECK (
    (
      runtime_cohort_id IS NULL
      AND runtime_contract_version IS NULL
      AND runtime_arch IS NULL
      AND runtime_kernel_sha256 IS NULL
      AND runtime_firecracker_sha256 IS NULL
      AND runtime_jailer_sha256 IS NULL
      AND runtime_python_rootfs_sha256 IS NULL
      AND runtime_desktop_rootfs_sha256 IS NULL
    ) OR (
      runtime_cohort_id ~ '^[0-9a-f]{64}$'
      AND runtime_contract_version = 4
      AND runtime_arch IN ('amd64', 'arm64')
      AND runtime_arch = CASE architecture WHEN 'x86_64' THEN 'amd64' ELSE 'arm64' END
      AND runtime_kernel_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_firecracker_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_jailer_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_python_rootfs_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_desktop_rootfs_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE host_heartbeats
  ADD COLUMN runtime_cohort_id text,
  ADD COLUMN runtime_contract_version integer,
  ADD COLUMN runtime_arch text,
  ADD COLUMN runtime_kernel_sha256 text,
  ADD COLUMN runtime_firecracker_sha256 text,
  ADD COLUMN runtime_jailer_sha256 text,
  ADD COLUMN runtime_python_rootfs_sha256 text,
  ADD COLUMN runtime_desktop_rootfs_sha256 text,
  ADD CONSTRAINT host_heartbeats_runtime_cohort_check CHECK (
    (
      runtime_cohort_id IS NULL
      AND runtime_contract_version IS NULL
      AND runtime_arch IS NULL
      AND runtime_kernel_sha256 IS NULL
      AND runtime_firecracker_sha256 IS NULL
      AND runtime_jailer_sha256 IS NULL
      AND runtime_python_rootfs_sha256 IS NULL
      AND runtime_desktop_rootfs_sha256 IS NULL
    ) OR (
      runtime_cohort_id ~ '^[0-9a-f]{64}$'
      AND runtime_contract_version = 4
      AND runtime_arch IN ('amd64', 'arm64')
      AND runtime_kernel_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_firecracker_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_jailer_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_python_rootfs_sha256 ~ '^[0-9a-f]{64}$'
      AND runtime_desktop_rootfs_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

-- Heartbeats are a bounded operational ring, not an unbounded event ledger.
-- Keep the newest 1,024 legacy samples per host, then reuse one five-minute
-- slot. Security/lifecycle transitions remain visible across the bounded
-- window while a compromised credential cannot grow this table forever.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY host_id ORDER BY observed_at DESC, id DESC
  ) AS ordinal
  FROM host_heartbeats
)
DELETE FROM host_heartbeats heartbeat
USING ranked
WHERE heartbeat.id = ranked.id AND ranked.ordinal > 1024;

ALTER TABLE host_heartbeats ADD COLUMN sample_slot integer;

WITH numbered AS (
  SELECT id, row_number() OVER (
    PARTITION BY host_id ORDER BY observed_at, id
  ) - 1 AS sample_slot
  FROM host_heartbeats
)
UPDATE host_heartbeats heartbeat
SET sample_slot = numbered.sample_slot
FROM numbered
WHERE heartbeat.id = numbered.id;

ALTER TABLE host_heartbeats
  ALTER COLUMN sample_slot SET NOT NULL,
  ADD CONSTRAINT host_heartbeats_sample_slot_check
    CHECK (sample_slot BETWEEN 0 AND 1023),
  ADD CONSTRAINT host_heartbeats_host_sample_slot_unique
    UNIQUE (host_id, sample_slot);

ALTER TABLE machines
  ADD COLUMN runtime_cohort_id text,
  ADD COLUMN source_sha256 text,
  ADD CONSTRAINT machines_runtime_source_binding_check CHECK (
    state IN ('stopped', 'failed', 'lost')
    OR (
      state IN ('requested', 'placing')
      AND host_id IS NULL
      AND runtime_cohort_id IS NULL
      AND source_sha256 IS NULL
    ) OR (
      state IN ('starting', 'running', 'stopping')
      AND host_id IS NOT NULL
      AND runtime_cohort_id ~ '^[0-9a-f]{64}$'
      AND source_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

CREATE INDEX hosts_runtime_schedulable_idx
  ON hosts (region_id, architecture, runtime_cohort_id, state, last_heartbeat_at);
CREATE INDEX machines_runtime_cohort_idx
  ON machines (runtime_cohort_id, state)
  WHERE runtime_cohort_id IS NOT NULL;

CREATE FUNCTION enforce_host_runtime_cohort_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.runtime_cohort_id IS NOT NULL AND (
    NEW.runtime_cohort_id IS DISTINCT FROM OLD.runtime_cohort_id
    OR NEW.runtime_contract_version IS DISTINCT FROM OLD.runtime_contract_version
    OR NEW.runtime_arch IS DISTINCT FROM OLD.runtime_arch
    OR NEW.runtime_kernel_sha256 IS DISTINCT FROM OLD.runtime_kernel_sha256
    OR NEW.runtime_firecracker_sha256 IS DISTINCT FROM OLD.runtime_firecracker_sha256
    OR NEW.runtime_jailer_sha256 IS DISTINCT FROM OLD.runtime_jailer_sha256
    OR NEW.runtime_python_rootfs_sha256 IS DISTINCT FROM OLD.runtime_python_rootfs_sha256
    OR NEW.runtime_desktop_rootfs_sha256 IS DISTINCT FROM OLD.runtime_desktop_rootfs_sha256
  ) THEN
    RAISE EXCEPTION 'host runtime cohort is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hosts_runtime_cohort_immutable
BEFORE UPDATE ON hosts
FOR EACH ROW EXECUTE FUNCTION enforce_host_runtime_cohort_immutable();

CREATE FUNCTION enforce_machine_runtime_source_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_cohort text;
  expected_source text;
BEGIN
  IF OLD.runtime_cohort_id IS NOT NULL AND (
    NEW.runtime_cohort_id IS DISTINCT FROM OLD.runtime_cohort_id
    OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
  ) THEN
    RAISE EXCEPTION 'machine runtime source binding is immutable';
  END IF;

  IF NEW.state IN ('starting', 'running', 'stopping') THEN
    SELECT h.runtime_cohort_id,
           CASE
             WHEN NEW.template_id IS NOT NULL
               THEN regexp_replace(t.checksum, '^sha256:', '')
             WHEN NEW.template_name = 'python' THEN h.runtime_python_rootfs_sha256
             WHEN NEW.template_name = 'desktop' THEN h.runtime_desktop_rootfs_sha256
             ELSE NULL
           END
      INTO expected_cohort, expected_source
      FROM hosts h
      LEFT JOIN templates t ON t.id = NEW.template_id
      WHERE h.id = NEW.host_id;
    IF expected_cohort IS NULL OR expected_source !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'assigned machine host or immutable source is not runtime-cohort ready';
    END IF;
    IF NEW.runtime_cohort_id IS NULL THEN
      NEW.runtime_cohort_id := expected_cohort;
    END IF;
    IF NEW.source_sha256 IS NULL THEN
      NEW.source_sha256 := expected_source;
    END IF;
    IF NEW.runtime_cohort_id IS DISTINCT FROM expected_cohort
       OR NEW.source_sha256 IS DISTINCT FROM expected_source THEN
      RAISE EXCEPTION 'machine runtime source does not match its assigned host';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER machines_runtime_source_immutable
BEFORE INSERT OR UPDATE ON machines
FOR EACH ROW EXECUTE FUNCTION enforce_machine_runtime_source_immutable();

CREATE OR REPLACE FUNCTION enforce_host_enrollment_grant_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'host enrollment grants cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.host_id IS DISTINCT FROM OLD.host_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.region_id IS DISTINCT FROM OLD.region_id
     OR NEW.address IS DISTINCT FROM OLD.address
     OR NEW.architecture IS DISTINCT FROM OLD.architecture
     OR NEW.total_vcpus IS DISTINCT FROM OLD.total_vcpus
     OR NEW.total_memory_mb IS DISTINCT FROM OLD.total_memory_mb
     OR NEW.total_disk_mb IS DISTINCT FROM OLD.total_disk_mb
     OR NEW.issued_by_organization_id IS DISTINCT FROM OLD.issued_by_organization_id
     OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.runtime_cohort_id IS DISTINCT FROM OLD.runtime_cohort_id
     OR NEW.runtime_contract_version IS DISTINCT FROM OLD.runtime_contract_version
     OR NEW.runtime_arch IS DISTINCT FROM OLD.runtime_arch
     OR NEW.runtime_kernel_sha256 IS DISTINCT FROM OLD.runtime_kernel_sha256
     OR NEW.runtime_firecracker_sha256 IS DISTINCT FROM OLD.runtime_firecracker_sha256
     OR NEW.runtime_jailer_sha256 IS DISTINCT FROM OLD.runtime_jailer_sha256
     OR NEW.runtime_python_rootfs_sha256 IS DISTINCT FROM OLD.runtime_python_rootfs_sha256
     OR NEW.runtime_desktop_rootfs_sha256 IS DISTINCT FROM OLD.runtime_desktop_rootfs_sha256 THEN
    RAISE EXCEPTION 'host enrollment grant identity is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'host enrollment consumption is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'host enrollment revocation is immutable';
  END IF;
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
     AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked host enrollment grant cannot be consumed';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed host enrollment grant cannot be revoked';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON COLUMN hosts.runtime_cohort_id IS
  'SHA-256 of the canonical signed runtime cohort contract; immutable after enrollment.';
COMMENT ON COLUMN machines.source_sha256 IS
  'Exact root filesystem or published-template SHA-256 selected atomically with the host.';
