package main

// publish.go — snapshot-to-template. POST /v1/machines/{id}/publish freezes a
// running machine as a named template under TemplatesDir/<name>: the same
// {snapshot_file, mem_file, rootfs.ext4} layout build-template.sh produces,
// plus a meta.json carrying the machine sizing (a published desktop must
// restore with the right memory/vsock/display, which the default template
// case would get wrong). New machines then boot from it in milliseconds via
// POST /v1/machines {"template": "<name>"}.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

var (
	ErrBadTemplateName = errors.New("template name must be 1-32 chars of [a-z0-9-], not a built-in")
	ErrTemplateExists  = errors.New("a template with that name already exists")
	ErrTemplateQuota   = errors.New("published template limit reached")
	ErrTemplateBuiltin = errors.New("built-in templates cannot be deleted")
)

var templateNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// templateMeta is persisted as TemplatesDir/<name>/meta.json and is what marks
// a template as user-published (build-template.sh templates have no meta.json).
type templateMeta struct {
	MemSizeMB      int    `json:"mem_size_mb"`
	VCPUs          int    `json:"vcpus"`
	Vsock          bool   `json:"vsock"`
	Display        bool   `json:"display"`
	InitPath       string `json:"init_path,omitempty"`
	HadNIC         bool   `json:"had_nic"`
	SourceTemplate string `json:"source_template"`
	CreatedAt      string `json:"created_at"`
}

// templateView is the JSON shape for GET /v1/templates and publish responses.
type templateView struct {
	Name           string `json:"name"`
	Published      bool   `json:"published"` // false for built-ins
	Display        bool   `json:"display"`
	SizeMB         int64  `json:"size_mb,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
	SourceTemplate string `json:"source_template,omitempty"`
}

func loadTemplateMeta(cfg Config, name string) (templateMeta, bool) {
	if !templateNameRe.MatchString(name) {
		return templateMeta{}, false
	}
	b, err := os.ReadFile(filepath.Join(cfg.TemplatesDir, name, "meta.json"))
	if err != nil {
		return templateMeta{}, false
	}
	var m templateMeta
	if json.Unmarshal(b, &m) != nil || m.MemSizeMB <= 0 {
		return templateMeta{}, false
	}
	return m, true
}

func isBuiltinTemplate(name string) bool {
	return name == "" || name == "python" || name == "desktop"
}

// publishedTemplates returns the names of user-published templates (dirs in
// TemplatesDir that carry a meta.json).
func publishedTemplates(cfg Config) []string {
	entries, err := os.ReadDir(cfg.TemplatesDir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() && fileExists(filepath.Join(cfg.TemplatesDir, e.Name(), "meta.json")) {
			names = append(names, e.Name())
		}
	}
	return names
}

// Publish snapshots a running machine into TemplatesDir/<name>. The snapshot
// pause/resume is handled inside CreateSnapshot; the machine keeps running.
func (mgr *Manager) Publish(id, name, creatorIP string) (templateView, error) {
	if !templateNameRe.MatchString(name) || isBuiltinTemplate(name) {
		return templateView{}, ErrBadTemplateName
	}
	target := filepath.Join(mgr.cfg.TemplatesDir, name)
	if _, err := os.Stat(target); err == nil {
		return templateView{}, ErrTemplateExists
	}
	if mgr.cfg.MaxTemplates <= 0 || len(publishedTemplates(mgr.cfg)) >= mgr.cfg.MaxTemplates {
		return templateView{}, ErrTemplateQuota
	}

	mgr.mu.Lock()
	m, ok := mgr.machines[id]
	if !ok || m.driver == nil {
		mgr.mu.Unlock()
		return templateView{}, ErrNotFound
	}
	drv := m.driver
	srcTemplate := m.Template
	mgr.mu.Unlock()

	// Publishing burns a create-rate token (it's as heavy as a fork) but not a
	// concurrent-machine slot — release as soon as the copy is done.
	if err := mgr.limiter.Acquire(creatorIP); err != nil {
		return templateView{}, err
	}
	defer mgr.limiter.Release(creatorIP)

	snapDir, err := drv.CreateSnapshot("pub-" + name)
	if err != nil {
		log.Printf("publish %s as %q: snapshot failed: %v", id, name, err)
		return templateView{}, ErrSnapshotUnavailable
	}

	tpl := mgr.cfg.Template(srcTemplate)
	meta := templateMeta{
		MemSizeMB:      tpl.MemSizeMB,
		VCPUs:          tpl.VCPUs,
		Vsock:          tpl.Vsock,
		Display:        tpl.Display,
		InitPath:       tpl.InitPath,
		HadNIC:         drv.tap != "",
		SourceTemplate: srcTemplate,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}
	mb, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(filepath.Join(snapDir, "meta.json"), mb, 0o644); err != nil {
		_ = os.RemoveAll(snapDir)
		return templateView{}, fmt.Errorf("write meta: %w", err)
	}

	// Move into place. Same filesystem by default (both under /opt/boring); fall
	// back to a copy for split mounts. Re-check existence to keep the window for
	// a concurrent publish of the same name tiny.
	if _, err := os.Stat(target); err == nil {
		_ = os.RemoveAll(snapDir)
		return templateView{}, ErrTemplateExists
	}
	if err := os.Rename(snapDir, target); err != nil {
		if cpErr := exec.Command("cp", "-a", snapDir, target).Run(); cpErr != nil {
			_ = os.RemoveAll(snapDir)
			return templateView{}, fmt.Errorf("install template: %v", cpErr)
		}
		_ = os.RemoveAll(snapDir)
	}

	view := templateView{
		Name:           name,
		Published:      true,
		Display:        meta.Display,
		SizeMB:         dirSizeMB(target),
		CreatedAt:      meta.CreatedAt,
		SourceTemplate: srcTemplate,
	}
	log.Printf("template %q published from machine %s (source=%s size=%dMB)", name, id, srcTemplate, view.SizeMB)
	return view, nil
}

// ListTemplates returns the built-ins plus every published template.
func (mgr *Manager) ListTemplates() []templateView {
	views := []templateView{
		{Name: "python", Published: false, Display: false},
		{Name: "desktop", Published: false, Display: true},
	}
	for _, name := range publishedTemplates(mgr.cfg) {
		meta, ok := loadTemplateMeta(mgr.cfg, name)
		if !ok {
			continue
		}
		views = append(views, templateView{
			Name:           name,
			Published:      true,
			Display:        meta.Display,
			SizeMB:         dirSizeMB(filepath.Join(mgr.cfg.TemplatesDir, name)),
			CreatedAt:      meta.CreatedAt,
			SourceTemplate: meta.SourceTemplate,
		})
	}
	return views
}

// DeleteTemplate removes a published template. Built-ins (and directories
// without a meta.json, i.e. build-template.sh output) are refused.
func (mgr *Manager) DeleteTemplate(name string) error {
	if isBuiltinTemplate(name) {
		return ErrTemplateBuiltin
	}
	if !templateNameRe.MatchString(name) {
		return ErrBadTemplateName
	}
	dir := filepath.Join(mgr.cfg.TemplatesDir, name)
	if !fileExists(filepath.Join(dir, "meta.json")) {
		if _, err := os.Stat(dir); err != nil {
			return ErrNotFound
		}
		return ErrTemplateBuiltin // exists but wasn't published via the API
	}
	return os.RemoveAll(dir)
}

func dirSizeMB(dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total / (1024 * 1024)
}
