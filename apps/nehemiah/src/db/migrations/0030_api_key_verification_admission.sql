-- Add a source-independent, full-presented-credential slot before Argon2. The
-- identifier is hashed in the application and only its fixed slot is stored, so
-- a valid key replayed from many source networks cannot multiply verifier work.
ALTER TABLE api_admission_windows
  DROP CONSTRAINT api_admission_windows_scope_check;

ALTER TABLE api_admission_windows
  ADD CONSTRAINT api_admission_windows_scope_check CHECK (scope IN (
    'preauth_ip',
    'preauth_api_key',
    'preauth_credential',
    'principal',
    'organization',
    'project'
  ));
