ALTER TABLE organizations
  ADD COLUMN max_machines integer NOT NULL DEFAULT 50
    CHECK (max_machines >= 0),
  ADD COLUMN max_vcpus integer NOT NULL DEFAULT 100
    CHECK (max_vcpus >= 0),
  ADD COLUMN max_memory_mb integer NOT NULL DEFAULT 102400
    CHECK (max_memory_mb >= 0),
  ADD COLUMN max_disk_mb bigint NOT NULL DEFAULT 512000
    CHECK (max_disk_mb >= 0);
