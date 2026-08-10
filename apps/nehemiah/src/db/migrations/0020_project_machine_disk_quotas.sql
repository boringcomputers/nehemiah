-- Project volume bytes and machine-disk reservations are distinct resources.
-- Preserve every existing project's effective machine-disk ceiling during the
-- split instead of silently replacing a customized max_storage_mb value.
ALTER TABLE projects
  ADD COLUMN max_disk_mb bigint;

UPDATE projects
SET max_disk_mb = max_storage_mb;

ALTER TABLE projects
  ALTER COLUMN max_disk_mb SET DEFAULT 102400,
  ALTER COLUMN max_disk_mb SET NOT NULL,
  ADD CONSTRAINT projects_max_disk_mb_json_safe
    CHECK (max_disk_mb BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT projects_max_storage_mb_json_safe
    CHECK (max_storage_mb BETWEEN 0 AND 9007199254740991);

COMMENT ON COLUMN projects.max_storage_mb IS
  'Maximum durable managed-volume allocation in MiB for this project.';
COMMENT ON COLUMN projects.max_disk_mb IS
  'Maximum active machine disk reservation in MiB for this project.';
