package main

import (
	"log"
	"time"
)

// The warm pool keeps a few desktops pre-booted and painted so a request for a
// desktop is handed one instantly instead of cold-booting (~5s + chromium).

// refillPool boots warm desktops in the background until the target is met,
// without exceeding MaxMachines. Safe to call often.
func (mgr *Manager) refillPool() {
	if mgr.cfg.DesktopPool <= 0 {
		return
	}
	mgr.mu.Lock()
	for len(mgr.pool)+mgr.warming < mgr.cfg.DesktopPool &&
		len(mgr.machines)+mgr.warming < mgr.cfg.MaxMachines {
		mgr.warming++
		go mgr.warmDesktop()
	}
	mgr.mu.Unlock()
}

// warmDesktop cold-boots a desktop, waits for it to paint, and pools it.
func (mgr *Manager) warmDesktop() {
	defer func() {
		mgr.mu.Lock()
		mgr.warming--
		mgr.mu.Unlock()
	}()
	tpl := mgr.cfg.Template("desktop")

	mgr.mu.Lock()
	if len(mgr.machines) >= mgr.cfg.MaxMachines || !mgr.hasMemoryFor(tpl) {
		mgr.mu.Unlock()
		return
	}
	id := mgr.newID()
	now := time.Now()
	m := &Machine{
		ID:        id,
		Status:    "warming",
		Template:  tpl.Name,
		Display:   tpl.Display,
		pooled:    true,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), // long; reaped only if it's never claimed
	}
	mgr.machines[id] = m
	mgr.mu.Unlock()

	drv, mode, bootMS, err := bootMachine(mgr.cfg, id, tpl, "", false)
	if err != nil {
		mgr.mu.Lock()
		delete(mgr.machines, id)
		mgr.mu.Unlock()
		log.Printf("warm desktop %s: boot failed: %v", id, err)
		return
	}
	if !mgr.cfg.JailerEnable {
		mgr.cgroups.Place(drv.PID(), id, tpl)
	}
	// Let X + chromium finish painting before it becomes claimable.
	time.Sleep(7 * time.Second)

	mgr.mu.Lock()
	m.driver = drv
	m.Mode = mode
	m.BootMS = bootMS
	m.Status = "ready"
	m.timer = time.AfterFunc(time.Until(m.ExpiresAt), func() { mgr.reap(id) })
	mgr.pool = append(mgr.pool, m)
	n := len(mgr.pool)
	mgr.mu.Unlock()
	log.Printf("warmed desktop %s into the pool (%d ready)", id, n)
}

// claimPooled hands a ready pooled desktop to a user, re-timed to their TTL.
// Returns nil if the pool is empty.
func (mgr *Manager) claimPooled(creatorIP string, ttl int, persistent bool) *Machine {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if len(mgr.pool) == 0 {
		return nil
	}
	m := mgr.pool[0]
	mgr.pool = mgr.pool[1:]
	m.pooled = false
	m.creatorIP = creatorIP
	m.Persistent = persistent
	m.ExpiresAt = time.Now().Add(time.Duration(ttl) * time.Second)
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	if !persistent {
		id := m.ID
		m.timer = time.AfterFunc(time.Until(m.ExpiresAt), func() { mgr.reap(id) })
	}
	m.BootMS = 0
	m.Mode = "warm"
	return m
}
