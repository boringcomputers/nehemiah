package main

import "sync"

const (
	maxConcurrentHostGuestOperations    = 32
	maxConcurrentMachineGuestOperations = 4
	guestOperationRetryAfterSeconds     = 1
)

// guestOperationLimiter bounds the host work performed on behalf of guest
// exec, file, and terminal requests. Admission is deliberately non-queued: a
// caller cannot turn the daemon into an unbounded waiting-room of goroutines,
// request bodies, or vsock connections.
type guestOperationLimiter struct {
	mu        sync.Mutex
	total     int
	byMachine map[string]int
}

func newGuestOperationLimiter() *guestOperationLimiter {
	return &guestOperationLimiter{byMachine: make(map[string]int)}
}

func (l *guestOperationLimiter) tryAcquire(machineID string) (func(), bool) {
	l.mu.Lock()
	if l.total >= maxConcurrentHostGuestOperations || l.byMachine[machineID] >= maxConcurrentMachineGuestOperations {
		l.mu.Unlock()
		return nil, false
	}
	l.total++
	l.byMachine[machineID]++
	l.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.total--
			l.byMachine[machineID]--
			if l.byMachine[machineID] == 0 {
				delete(l.byMachine, machineID)
			}
			l.mu.Unlock()
		})
	}, true
}
