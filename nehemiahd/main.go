package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg := LoadConfig()

	// Flags override env where provided (env already loaded as defaults).
	flag.StringVar(&cfg.Addr, "addr", cfg.Addr, "listen address")
	flag.IntVar(&cfg.MaxMachines, "max", cfg.MaxMachines, "max live machines")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("nehemiahd ")

	// Clean up any VMs/artifacts orphaned by a previous unclean exit before we
	// start booting new ones (nehemiahd starts with an empty map, so anything
	// present is stale).
	reapOrphans(cfg)

	mgr := NewManager(cfg)
	mgr.StartReaper()

	srv := NewServer(cfg, mgr)
	httpSrv := &http.Server{
		Addr:    cfg.Addr,
		Handler: srv,
	}

	// Start the HTTP server.
	go func() {
		log.Printf("listening on %s (max=%d, auth=%v)", cfg.Addr, cfg.MaxMachines, cfg.Token != "")
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server error: %v", err)
		}
	}()

	// Wait for a termination signal.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down...")

	// Graceful HTTP shutdown, then tear down all machines.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("http shutdown: %v", err)
	}
	mgr.Shutdown()
	log.Printf("bye")
}
