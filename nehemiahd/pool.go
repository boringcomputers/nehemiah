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
	if mgr.cfg.DesktopPool <= 0 || mgr.cfg.NehemiahMode {
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
		VCPUs:     tpl.VCPUs,
		MemoryMB:  tpl.MemSizeMB,
	}
	mgr.machines[id] = m
	mgr.transitionLocked(m, "", "warming", "warm_pool")
	mgr.persistLocked()
	mgr.mu.Unlock()

	drv, mode, bootMS, err := mgr.boot(mgr.cfg, id, tpl, "", false, false, 0)
	if err != nil {
		mgr.mu.Lock()
		delete(mgr.machines, id)
		mgr.transitionLocked(m, "warming", "failed", "warm_pool_boot")
		mgr.persistLocked()
		mgr.mu.Unlock()
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventWarmPoolBootFailed, managedHostLogFields{MachineID: id, Err: err})
		} else {
			log.Printf("warm desktop %s: boot failed: %v", id, err)
		}
		return
	}
	if !mgr.cfg.JailerEnable {
		if err := mgr.cgroups.Place(drv.PID(), id, tpl, drv.overlay); err != nil {
			if mgr.cfg.NehemiahMode {
				drv.Close()
				mgr.rollback(id)
				logManagedHostEvent(managedHostEventCgroupPlaceFailed, managedHostLogFields{MachineID: id, Err: err})
				return
			}
			log.Printf("warm desktop %s: cgroup limits unavailable: %v", id, err)
		}
	}
	mgr.mu.Lock()
	m.driver = drv
	m.Mode = mode
	m.BootMS = bootMS
	m.StartedAt = drv.startedAt
	if m.StartedAt.IsZero() {
		m.StartedAt = time.Now().UTC()
	}
	m.Status = "starting"
	m.timer = time.AfterFunc(time.Until(m.ExpiresAt), func() { mgr.reap(id) })
	mgr.transitionLocked(m, "warming", "starting", "warm_pool_vmm_started")
	mgr.persistLocked()
	mgr.mu.Unlock()
	if !mgr.awaitReady(id, 15*time.Second) {
		mgr.rollback(id)
		if mgr.cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventWarmPoolReadinessFailed, managedHostLogFields{MachineID: id})
		} else {
			log.Printf("warm desktop %s: guest agent did not become ready", id)
		}
		return
	}
	// Let X + chromium finish painting after guest-level readiness.
	time.Sleep(7 * time.Second)

	mgr.mu.Lock()
	if _, exists := mgr.machines[id]; !exists {
		mgr.mu.Unlock()
		return
	}
	mgr.pool = append(mgr.pool, m)
	mgr.transitionLocked(m, "running", "running", "warm_pool_ready")
	mgr.persistLocked()
	n := len(mgr.pool)
	mgr.mu.Unlock()
	if mgr.cfg.NehemiahMode {
		logManagedHostEvent(managedHostEventWarmPoolReady, managedHostLogFields{MachineID: id, Count: int64(n)})
	} else {
		log.Printf("warmed desktop %s into the pool (%d ready)", id, n)
	}
}

// claimPooled hands a ready pooled desktop to a user, re-timed to their TTL.
// Returns nil if the pool is empty.
func (mgr *Manager) claimPooled(creatorIP string, ttl int, persistent bool, options machineCreateOptions) *Machine {
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
	m.LeaseID = options.LeaseID
	m.Metadata = cloneMetadata(options.Metadata)
	m.IdempotencyKey = options.IdempotencyKey
	m.requestFingerprint = options.RequestFingerprint
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
	mgr.transitionLocked(m, "running", "running", "warm_pool_claimed")
	mgr.persistLocked()
	return m
}
