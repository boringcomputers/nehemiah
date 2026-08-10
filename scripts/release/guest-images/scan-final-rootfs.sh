#!/usr/bin/env bash
# Runs as root in the already-built guest container with the exact assembled
# root filesystem mounted read-only. No network is available during scanning.
set -euo pipefail
export LC_ALL=C
umask 022

if [[ "$#" -ne 10 ]]; then
  echo "usage: scan-final-rootfs.sh TRIVY CACHE DB_EVIDENCE POLICY ALLOWLIST ROOT FLAVOR ARCH ARTIFACT_SHA OUTPUT" >&2
  exit 64
fi
trivy="$1"
cache="$2"
database_evidence="$3"
policy="$4"
allowlist="$5"
rootfs="$6"
flavor="$7"
arch="$8"
artifact_sha="$9"
output="${10}"
case "$flavor" in python | desktop) ;; *) echo "invalid flavor" >&2; exit 64 ;; esac
case "$arch" in amd64 | arm64) ;; *) echo "invalid architecture" >&2; exit 64 ;; esac
[[ "$artifact_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid artifact digest" >&2; exit 64; }
for input in "$trivy" "$database_evidence" "$policy" "$allowlist"; do
  [[ -f "$input" && ! -L "$input" ]] || { echo "unsafe or missing scan input" >&2; exit 1; }
done
[[ -d "$cache" && ! -L "$cache" && -d "$rootfs" && ! -L "$rootfs" ]] \
  || { echo "unsafe scan directory" >&2; exit 1; }

allowlist_sha="$(sha256sum "$allowlist" | awk '{print $1}')"
expected_allowlist_sha="$(jq -er '.vulnerabilityScan.allowlistSha256' "$policy")"
[[ "$allowlist_sha" == "$expected_allowlist_sha" ]] \
  || { echo "vulnerability allowlist checksum mismatch" >&2; exit 1; }
jq -e '
  .schemaVersion == 1 and
  (.exceptions | type == "array") and
  (.exceptions | all(
    (keys | sort) == ["expiresAt", "flavor", "id", "package", "reason"] and
    (.id | test("^CVE-[0-9]{4}-[0-9]{4,}$")) and
    (.package | test("^[A-Za-z0-9][A-Za-z0-9+._:-]*$")) and
    (.flavor == "python" or .flavor == "desktop") and
    (.expiresAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.reason | type == "string" and length >= 20 and length <= 500)
  ))
' "$allowlist" >/dev/null || { echo "invalid vulnerability allowlist" >&2; exit 1; }

report="${output}.trivy.json"
"$trivy" --cache-dir "$cache" rootfs \
  --skip-db-update --offline-scan --scanners vuln --pkg-types os,library \
  --detection-priority comprehensive --severity HIGH,CRITICAL \
  --list-all-pkgs --format json --output "$report" "$rootfs"

now="$(date -u +%s)"
max_expiry=$((now + 30 * 24 * 3600))
jq -e --arg flavor "$flavor" --argjson now "$now" --argjson maxExpiry "$max_expiry" \
  --slurpfile allowlists "$allowlist" '
  def findings:
    [.Results[]? as $result | $result.Vulnerabilities[]? |
      select(.Severity == "HIGH" or .Severity == "CRITICAL") |
      {
        id: .VulnerabilityID,
        package: .PkgName,
        installedVersion: .InstalledVersion,
        fixedVersion: (.FixedVersion // ""),
        severity: .Severity,
        target: $result.Target,
        class: $result.Class,
        type: $result.Type
      }];
  $allowlists[0] as $allowlist |
  (findings) as $findings |
  ([$allowlist.exceptions[] | select(.flavor == $flavor)] | unique_by([.id, .package, .flavor]) | length) ==
    ([$allowlist.exceptions[] | select(.flavor == $flavor)] | length) and
  ([$allowlist.exceptions[] | select(.flavor == $flavor) |
    (.expiresAt | fromdateiso8601) | select(. <= $now or . > $maxExpiry)] | length) == 0 and
  ($findings | all(. as $finding |
    any($allowlist.exceptions[];
      .flavor == $flavor and .id == $finding.id and .package == $finding.package))) and
  ([$allowlist.exceptions[] | select(.flavor == $flavor) as $exception |
    select(any($findings[]; .id == $exception.id and .package == $exception.package) | not)] | length) == 0
' "$report" >/dev/null || {
  echo "unapproved high/critical vulnerability or invalid/stale exception" >&2
  jq -r '[.Results[]? as $result | $result.Vulnerabilities[]? | select(.Severity == "HIGH" or .Severity == "CRITICAL") | [.VulnerabilityID,.PkgName,.InstalledVersion,(.FixedVersion // ""),.Severity,$result.Target] | @tsv] | .[]' "$report" >&2
  exit 1
}

# list-all-pkgs must prove that the injected static Go guest agent was included
# in the final filesystem scan, not merely assumed equivalent to the OCI stage.
jq -e '[.Results[]? | select(.Target | endswith("opt/boring/bin/bc-guest-agent"))] | length == 1' \
  "$report" >/dev/null || { echo "Trivy did not inventory the injected guest agent" >&2; exit 1; }

report_sha="$(sha256sum "$report" | awk '{print $1}')"
finding_count="$(jq '[.Results[]? | .Vulnerabilities[]? | select(.Severity == "HIGH" or .Severity == "CRITICAL")] | length' "$report")"
exception_count="$(jq --arg flavor "$flavor" '[.exceptions[] | select(.flavor == $flavor)] | length' "$allowlist")"
jq -n \
  --arg flavor "$flavor" --arg architecture "$arch" \
  --arg artifactSha256 "$artifact_sha" --arg reportSha256 "$report_sha" \
  --arg allowlistSha256 "$allowlist_sha" \
  --argjson findingCount "$finding_count" --argjson exceptionCount "$exception_count" \
  --slurpfile scanner "$database_evidence" '
  {
    flavor: $flavor,
    architecture: $architecture,
    artifactSha256: $artifactSha256,
    scanner: $scanner[0],
    reportSha256: $reportSha256,
    allowlistSha256: $allowlistSha256,
    highCriticalFindings: $findingCount,
    approvedExceptions: $exceptionCount,
    rejectedFindings: 0
  }' > "$output"
chown "${OUTPUT_UID:?}:${OUTPUT_GID:?}" "$output" "$report"
