# Running Nehemiah locally (Mac & Windows)

**The Mac path is built and proven** — one command
([`setup-local.sh`](setup-local.sh)) turns an Apple Silicon Mac into a boring
computers host (in a Lima nested-virt VM), and a real arm64 Firecracker microVM
boots on it in **~5 ms**. Windows is designed but not yet wired up (it's the
easier path — see below).

nehemiahd runs Firecracker microVMs, which need **Linux + a functional `/dev/kvm`**.
Neither macOS nor Windows provides that natively, but both can host a Linux VM
that _does_ — Firecracker needs only **one** level of nested virtualization, which
modern Macs and Windows 11 both expose.

## Quickstart (Mac)

```sh
brew install lima                                  # once
NEHEMIAH_ANTHROPIC_KEY=sk-ant-... ./infra/local/setup-local.sh
# → builds the arm64 stack in a Lima VM, forwards :8080 to the Mac at :8088
echo 'NEHEMIAH_URL=http://localhost:8088' > apps/web/.env
npm run dev -w web                                 # → http://localhost:5173
```

`SKIP_DESKTOP=1` skips the ~8-min desktop image (the python shell still works).
`limactl stop boring` frees the VM's RAM.

| Path                    | Status                          | Why                                                              | Extra work vs a Linux box                             |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| **Apple Silicon Mac**   | ✅ **built + booted a microVM** | nested virt on M3+/macOS 15+ exposes `/dev/kvm` in a Linux guest | arm64 rebuilds — done, automated by `setup-local.sh`  |
| **Windows 11 (x86_64)** | ✅ designed (not yet wired)     | WSL2 ships a KVM-enabled kernel; nested virt on by default       | ~none — the **existing x86_64 images work unchanged** |

---

## Apple Silicon — verified on an M4 Pro / macOS 26

The make-or-break question is whether a Linux VM on the Mac gets a _working_ KVM
that Firecracker can boot on. **It does.** Verified hands-on in a
[Lima](https://lima-vm.io) `vz` guest with `nestedVirtualization: true`
([`lima-boring.yaml`](lima-boring.yaml)):

```text
$ limactl shell boring -- kvm-ok
INFO: /dev/kvm exists
KVM acceleration can be used

# and — the definitive proof — a Firecracker aarch64 microVM actually boots:
Booting Linux on physical CPU 0x0000000000
Linux version 6.1.102 ...
Run /sbin/init as init process
systemd[1]: systemd 249.11 running in system mode        # ~4s to systemd
```

So Firecracker + KVM + an aarch64 kernel + rootfs all work on the Mac. All the
arm64 artifacts exist (verified live):

- Firecracker `aarch64` binary + jailer — `firecracker-v1.16.1-aarch64.tgz` (200 ✓)
- aarch64 CI kernel — `s3…/firecracker-ci/v1.10/aarch64/vmlinux-6.1.102` (✓)
- Go `linux-arm64`, Alpine `aarch64`, Node `linux-arm64` — all published

### Steps (Mac)

1. **Prereqs:** M3+ (M4 Pro ✓) on macOS 15+; `brew install lima`.
2. **Boot a nested-virt Linux guest:** `limactl start --name=boring infra/local/lima-boring.yaml`
   (arm64 Ubuntu 24.04, `vz`, `nestedVirtualization: true`).
3. **Confirm KVM:** `limactl shell boring -- sudo kvm-ok` → "KVM acceleration can be used".
4. **Run the arm64-ported setup inside the guest** (see _Repo changes_ below), with
   `BIND_LOCALHOST=1`.
5. **Reach it from macOS** via the Lima-forwarded port / `ssh -L 8080:localhost:8080`,
   then point `apps/web/.env` at it and `npm run dev`.

### What was verified on the M4 Pro

- **python computer:** boots in **5 ms** (snapshot restore works on aarch64 too),
  `uname -m`→`aarch64` over the serial TTY.
- **desktop computer:** boots + renders over VNC — X, the terminal, the calculator,
  and **all** the coding agents (`claude`, `codex`, `cursor-agent`, `pi` — cursor's
  arm64-linux build works). Cold boot is ~45 s under nested virt (vs ~3 s bare-metal);
  the warm pool makes it instant.
- **chromium:** the browser launches on arm64 (validated — window + address bar).
  Two arm64 fixes were needed and are in `build-desktop-rootfs.sh`: call the real
  ELF `/usr/lib/chromium/chromium` (the Debian `/usr/bin/chromium` wrapper aborts
  with `[: -lt: unexpected operator`), and start a system **dbus** first.
- The site (`npm run dev`) launches computers against the Mac host through the
  browser.

### Caveats (Mac)

- **Guest internet:** the uplink is auto-detected (`ip route show default`), but
  the egress firewall blocks RFC1918 destinations — and under Lima the guest's own
  gateway _is_ RFC1918 (double NAT), so a microVM's traffic to the outside is
  dropped. The desktop's browser opens but pages don't load until the firewall is
  relaxed for the Lima gateway (or `NEHEMIAH_NET` egress rules are loosened for local
  mode). Doesn't affect snapshot-restore or the desktop UI.
- **Rebuilding the desktop image in a _live_ Lima VM is finicky** — nehemiahd's
  warm-pool VM can hold `desktop.ext4` open. `setup-local.sh` builds it cleanly on
  first run; to rebuild, `limactl stop boring` (or stop nehemiahd) first.
- Cold desktop boot is slow under nested virt (~45 s); the warm pool hides it.

---

## Windows 11 — the easy path (x86_64)

**No image rebuild needed** — Windows PCs are x86_64, so the repo's existing images
work as-is. On **Windows 11**, WSL2's Microsoft kernel ships **KVM enabled** and
`.wslconfig` `nestedVirtualization` defaults to **true**, so `/dev/kvm` appears in
the distro with no custom kernel.

### Steps (Windows)

1. **Prereqs:** Windows **11** x86_64 (not 10, not ARM), VT-x/AMD-V enabled in BIOS.
2. `wsl --install -d Ubuntu-24.04` then `wsl --update`.
3. `%UserProfile%\.wslconfig` → `[wsl2]\nnestedVirtualization=true`, then `wsl --shutdown`.
4. Verify: in the distro, `ls -l /dev/kvm` exists and `grep -Ewc '(vmx|svm)' /proc/cpuinfo` > 0.
5. Enable systemd (`/etc/wsl.conf` → `[boot]\nsystemd=true`; `wsl --shutdown`) — setup.sh
   installs a systemd unit.
6. Fix `/dev/kvm` perms (`usermod -aG kvm $USER`) and run the **local-mode** setup
   against the distro.

### Caveats (Windows)

- **Hard wall:** Windows **10** (no nested virt) and **ARM64 Windows** (KVM needs EL2).
- Needs testing under WSL2: jailer's cgroup/namespace setup, and `net-setup.sh`'s
  bridge/NAT under WSL2 networking (may need `networkingMode=mirrored`).

---

## Repo changes needed (both paths)

The infra scripts assume _x86_64_ and _SSH into a remote box_. To make
`setup.sh --arch aarch64 --local` real:

**P0 — arch + local mode**

- `setup.sh`: relax the `[[ ARCH == x86_64 ]]` guard to `{x86_64,aarch64}`; make the
  Go tarball arch-aware (`linux-amd64` ↔ `linux-arm64`); add a **LOCAL** target that
  runs on the same host (or `wsl`/`limactl shell`) instead of over SSH.
- `bootstrap.sh`: allowlist `{x86_64,aarch64}`; firecracker download URL + extracted
  binary names `…-x86_64` → `…-aarch64`; kernel URLs → the `…/aarch64/vmlinux-*` CI
  paths.

**P1 — arm64 image builds**

- `build-rootfs.sh`: `ALPINE_ARCH` from the target arch (aarch64 is first-class).
- `build-desktop-rootfs.sh`: Node tarball `linux-x64` → `linux-arm64`; debootstrap
  auto-selects arm64 from the guest; verify `cursor-agent` arm64.
- `build-template.sh`: confirm snapshot/restore on aarch64 (best-effort, cold-boot
  fallback already exists).

**No change:** `nehemiahd` itself — it's Go (`CGO_ENABLED=0`), builds native arm64 with
no source edits. The `/dev/kvm` checks (`bootstrap.sh`, `setup.sh`) are correct and
stay.

---

## Bottom line

- **Windows 11 / x86_64:** low effort — mostly a WSL2 local-mode wrapper around the
  existing scripts. Best "runs on a normal machine" story.
- **Apple Silicon:** proven bootable on this M4; ~1–2 days of mechanical arm64
  substitution across four shell scripts + rebuilding the images. The risky part
  (does KVM work?) is already answered: **yes**.
