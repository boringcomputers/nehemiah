package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
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

	if cfg.NehemiahMode {
		// Managed events already carry an RFC3339 timestamp. Keeping the standard
		// logger prefix off makes each emitted line standalone JSON.
		log.SetFlags(0)
		log.SetPrefix("")
	} else {
		log.SetFlags(log.LstdFlags | log.Lmsgprefix)
		log.SetPrefix("nehemiahd ")
	}
	if err := cfg.Validate(); err != nil {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventConfigurationRejected, managedHostLogFields{Err: err})
			os.Exit(1)
		}
		log.Fatalf("invalid configuration: %v", err)
	}
	if err := cfg.ValidateRuntime(); err != nil {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventPrerequisitesRejected, managedHostLogFields{Err: err})
			os.Exit(1)
		}
		log.Fatalf("host prerequisites: %v", err)
	}

	// The one-time fleet token is kept only in the outbound enrollment client,
	// never in the long-lived Manager or HTTP Server configuration copies.
	controlPlaneCfg := cfg
	cfg.FleetBootstrapToken = ""
	mgr := NewManager(cfg)
	if cfg.NehemiahMode && !mgr.cgroups.Enabled() {
		logManagedHostEvent(managedHostEventPrerequisitesRejected, managedHostLogFields{})
		os.Exit(1)
	}
	if cfg.NehemiahMode && jailerParentCgroup() == "" {
		logManagedHostEvent(managedHostEventPrerequisitesRejected, managedHostLogFields{})
		os.Exit(1)
	}
	if cfg.NehemiahMode {
		report, err := mgr.Reconcile()
		if err != nil {
			logManagedHostEvent(managedHostEventRuntimeReconciliationFailed, managedHostLogFields{Err: err})
			os.Exit(1)
		}
		logManagedHostEvent(managedHostEventRuntimeReconciled, managedHostLogFields{
			Count: int64(report.Reattached), SecondaryCount: int64(report.Lost),
			Total: int64(report.Orphans), Quarantined: report.StateQuarantined,
		})
	} else {
		// Local mode preserves the historical behavior: an unclean daemon exit
		// invalidates serial-console ownership, so stale VMs are reaped.
		reapOrphans(cfg)
	}
	dnsServer, err := mgr.StartManagedEgressDNS()
	if err != nil {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventEgressDNSStartFailed, managedHostLogFields{Err: err})
			os.Exit(1)
		}
		log.Fatalf("managed egress DNS: %v", err)
	}
	mgr.StartReaper()

	srv := NewServer(cfg, mgr)
	httpSrv := &http.Server{
		Addr:    cfg.Addr,
		Handler: srv,
	}
	if cfg.NehemiahMode {
		httpSrv.ErrorLog = log.New(managedHostHTTPErrorWriter{}, "", 0)
	}
	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventListenerFailed, managedHostLogFields{Err: err})
			os.Exit(1)
		}
		log.Fatalf("listen failed: error_type=%s", safeTelemetryErrorType(err))
	}
	telemetryContext, cancelTelemetry := context.WithTimeout(context.Background(), 20*time.Second)
	telemetry, err := newHostTelemetry(telemetryContext, cfg, mgr)
	cancelTelemetry()
	if err != nil {
		_ = listener.Close()
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventTelemetryInitializationFailed, managedHostLogFields{Err: err})
			os.Exit(1)
		}
		log.Fatalf("telemetry initialization failed: error_type=%s", safeTelemetryErrorType(err))
	}
	srv.SetTelemetry(telemetry)

	// Bind the host API before announcing schedulable capacity to the control
	// plane, so the first successful heartbeat can never race listener startup.
	go func() {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventListening, managedHostLogFields{Limit: int64(cfg.MaxMachines), AuthConfigured: cfg.Token != ""})
		} else {
			log.Printf("listening (max=%d, auth=%v)", cfg.MaxMachines, cfg.Token != "")
		}
		if err := httpSrv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			if cfg.NehemiahMode {
				logManagedHostEvent(managedHostEventHTTPServerFailed, managedHostLogFields{Err: err})
				os.Exit(1)
			}
			log.Fatalf("http server failed: error_type=%s", safeTelemetryErrorType(err))
		}
	}()

	fleetCtx, stopFleet := context.WithCancel(context.Background())
	var fleetDone chan struct{}
	if cfg.NehemiahMode {
		fleetDone = make(chan struct{})
		client := newControlPlaneClient(controlPlaneCfg, mgr, telemetry)
		controlPlaneCfg.FleetBootstrapToken = ""
		go func() {
			defer close(fleetDone)
			client.Run(fleetCtx)
		}()
	}

	// Wait for a termination signal.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	if cfg.NehemiahMode {
		logManagedHostEvent(managedHostEventShutdownStarted, managedHostLogFields{})
	} else {
		log.Printf("shutting down...")
	}
	stopFleet()
	if fleetDone != nil {
		<-fleetDone
	}
	if dnsServer != nil {
		if err := dnsServer.Close(); err != nil {
			if cfg.NehemiahMode {
				logManagedHostEvent(managedHostEventEgressDNSShutdownFailed, managedHostLogFields{Err: err})
			} else {
				log.Printf("managed egress DNS shutdown failed: error_type=%s", safeTelemetryErrorType(err))
			}
		}
	}

	// Graceful HTTP shutdown. Nehemiah mode preserves VMM processes for verified
	// startup reattachment; local mode keeps its stop-everything semantics.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventHTTPShutdownFailed, managedHostLogFields{Err: err})
		} else {
			log.Printf("http shutdown failed: error_type=%s", safeTelemetryErrorType(err))
		}
	}
	if cfg.NehemiahMode {
		mgr.ShutdownPreserve()
	} else {
		mgr.Shutdown()
	}
	telemetryShutdownContext, cancelTelemetryShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	if err := telemetry.shutdown(telemetryShutdownContext); err != nil {
		if cfg.NehemiahMode {
			logManagedHostEvent(managedHostEventTelemetryShutdownFailed, managedHostLogFields{Err: err})
		} else {
			log.Printf("telemetry shutdown failed: error_type=%s", safeTelemetryErrorType(err))
		}
	}
	cancelTelemetryShutdown()
	if cfg.NehemiahMode {
		logManagedHostEvent(managedHostEventShutdownComplete, managedHostLogFields{})
	} else {
		log.Printf("bye")
	}
}
