package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := LoadConfig()
	if err != nil {
		logger.Error("invalid configuration", "error_type", "configuration")
		os.Exit(1)
	}
	telemetryContext, cancelTelemetry := context.WithTimeout(context.Background(), 20*time.Second)
	telemetry, err := newGatewayTelemetry(telemetryContext, cfg.Telemetry)
	cancelTelemetry()
	if err != nil {
		logger.Error("could not initialize telemetry", "error_type", fmt.Sprintf("%T", err))
		os.Exit(1)
	}
	gatewayRuntime, err := newGateway(cfg, telemetry)
	if err != nil {
		logger.Error("could not construct gateway", "error_type", fmt.Sprintf("%T", err))
		os.Exit(1)
	}
	h := withRequestTelemetry(logger, gatewayRuntime, telemetry)
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	stopContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		<-stopContext.Done()
		gatewayRuntime.streams.startDrain()
		shutdownContext, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			logger.Error("gateway shutdown failed", "error_type", fmt.Sprintf("%T", err))
		}
		if err := gatewayRuntime.streams.wait(shutdownContext); err != nil {
			logger.Warn("gateway stream drain grace expired", "active_streams", gatewayRuntime.streams.active())
			gatewayRuntime.streams.forceClose()
			forcedContext, forcedCancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = gatewayRuntime.streams.wait(forcedContext)
			forcedCancel()
		}
		telemetryContext, telemetryCancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := telemetry.shutdown(telemetryContext); err != nil {
			logger.Error("telemetry shutdown failed", "error_type", fmt.Sprintf("%T", err))
		}
		telemetryCancel()
		close(shutdownDone)
	}()

	logger.Info("gateway listening")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("gateway stopped unexpectedly", "error_type", fmt.Sprintf("%T", err))
		os.Exit(1)
	}
	<-shutdownDone
}
