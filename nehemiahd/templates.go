package main

// Template describes a machine flavor: which rootfs, how big, and whether it
// carries a vsock-backed VNC display (desktop) or just a serial shell (python).
type Template struct {
	Name      string
	Rootfs    string // absolute path; empty => cfg.BaseRootfs
	MemSizeMB int
	VCPUs     int
	InitPath  string // init= kernel arg; empty => rootfs default (/sbin/init)
	Vsock     bool   // configure a vsock device (VNC desktops use it)
	Snapshot  bool   // eligible for snapshot restore from TemplatesDir/<name>
	Display   bool   // exposes a VNC framebuffer on guest vsock port 5900

	// RestoreNet: the snapshot was taken from a machine WITH a NIC, so a restore
	// resumes on the source's MAC/IP and must be re-addressed before joining the
	// bridge (same dance as a fork). Set from a published template's meta.json.
	RestoreNet bool
}

// Template resolves a requested template name to its flavor. Built-in names
// (python, desktop) are hardcoded; any other name is a user-published template
// if TemplatesDir/<name>/meta.json exists (its snapshot carries the machine
// sizing it was taken with), else it falls back to the default headless sandbox.
func (c Config) Template(name string) Template {
	if name == "" {
		name = "python"
	}
	switch name {
	case "desktop":
		return Template{
			Name:      "desktop",
			Rootfs:    c.DesktopRootfs,
			MemSizeMB: 2560, // chromium + a coding agent need headroom
			VCPUs:     2,
			InitPath:  "/sbin/boring-init",
			Vsock:     true,
			Snapshot:  false, // cold boot for now; Xvfb comes up in a few seconds
			Display:   true,
		}
	default:
		if meta, ok := loadTemplateMeta(c, name); ok {
			return Template{
				Name:       name,
				Rootfs:     c.BaseRootfs, // unused on restore; snapDir rootfs wins
				MemSizeMB:  meta.MemSizeMB,
				VCPUs:      meta.VCPUs,
				InitPath:   meta.InitPath,
				Vsock:      meta.Vsock,
				Snapshot:   true,
				Display:    meta.Display,
				RestoreNet: meta.HadNIC,
			}
		}
		return Template{
			Name:      name,
			Rootfs:    c.BaseRootfs,
			MemSizeMB: c.MemSizeMB,
			VCPUs:     c.VCPUs,
			Snapshot:  true,
			Display:   false,
		}
	}
}

// VsockPort is the guest vsock port the desktop VNC server (x11vnc via socat)
// listens on.
const VsockPort = 5900
