import { createServer } from 'node:http';
import { Effect, Redacted } from 'effect';
import { PostgresApiAdmission } from './auth/api-admission.js';
import { ApiKeyService, PostgresApiKeyStore } from './auth/api-key.js';
import { clerkVerifier } from './auth/clerk.js';
import { DeviceAuthorizationService } from './auth/device.js';
import { AuditService } from './audit/audit.js';
import { StripeWebhookService } from './billing/stripe.js';
import { AuthoritativeMetering } from './billing/metering.js';
import { UsageLedger } from './billing/usage.js';
import { NehemiahdClient } from './clients/nehemiahd.js';
import { NehemiahdTemplateClient, templateObjectOrigins } from './clients/nehemiahd-templates.js';
import { loadConfig } from './config.js';
import { Database } from './db/client.js';
import { HostService } from './domain/hosts.js';
import { HostCredentialCipher, PostgresHostCredentialResolver } from './domain/host-credentials.js';
import { IdentityLifecycleService } from './domain/identity-lifecycle.js';
import { MachineService, PostgresMachineRepository } from './domain/machines.js';
import { OrganizationService } from './domain/organizations.js';
import { ProjectService } from './domain/projects.js';
import { StreamAdmissionService } from './domain/stream-admission.js';
import { TemplateService } from './domain/templates.js';
import { VolumeService } from './domain/volumes.js';
import { healthz, readyz } from './http/health.js';
import { admitPendingRequestBody, closeAfterResponse, controlPlaneHttpServerOptions, incomingRequest, PendingRequestBodyAdmission } from './http/incoming-request.js';
import { openapi } from './http/openapi.js';
import { HttpRequestError, problem, Router } from './http/router.js';
import { registerApiKeyRoutes } from './http/routes/api-keys.js';
import { registerBillingRoutes } from './http/routes/billing.js';
import { registerDeviceAuthorizationRoutes } from './http/routes/device-authorization.js';
import { registerInternalHostRoutes } from './http/routes/internal-hosts.js';
import { registerIdentityLifecycleRoutes } from './http/routes/identity-lifecycle.js';
import { registerMachineRoutes } from './http/routes/machines.js';
import { registerOrganizationRoutes } from './http/routes/organizations.js';
import { registerStripeWebhookRoute } from './http/routes/stripe-webhook.js';
import { registerTemplateRoutes } from './http/routes/templates.js';
import { registerVolumeRoutes } from './http/routes/volumes.js';
import { aggregateUsage } from './jobs/aggregate-usage.js';
import { markStaleHosts } from './jobs/mark-stale-hosts.js';
import { reapExpiredDeviceAuthorizations } from './jobs/reap-expired-device-authorizations.js';
import { reapExpiredGatewayGrants } from './jobs/reap-expired-gateway-grants.js';
import { MachineReconciler } from './jobs/reconcile-machines.js';
import { reapExpiredMachines } from './jobs/reap-expired-machines.js';
import { VolumeDeletionWorker } from './jobs/schedule-volume-deletions.js';
import { PostgresTemplateReplicaRepository, TemplateReplicationJob } from './jobs/replicate-template.js';
import { S3TemplateObjectStore } from './providers/storage/s3.js';
import { S3VolumeObjectStore } from './providers/storage/s3-volumes.js';
import { Scheduler } from './scheduler/scheduler.js';
import { ControlPlaneShutdown } from './shutdown.js';
import { initializeTelemetry, log, registerDatabasePoolMetrics, registerMeteringMetrics, requestId, withControlPlaneRequestTelemetry, withJobTelemetry } from './telemetry.js';
const send = async (response, target) => {
    target.statusCode = response.status;
    response.headers.forEach((value, name) => target.setHeader(name, value));
    target.end(Buffer.from(await response.arrayBuffer()));
};
export const buildRouter = () => {
    const router = new Router();
    router.get('/healthz', healthz);
    router.get('/readyz', readyz);
    router.get('/openapi.json', openapi);
    registerMachineRoutes(router);
    registerApiKeyRoutes(router);
    registerIdentityLifecycleRoutes(router);
    registerBillingRoutes(router);
    registerDeviceAuthorizationRoutes(router);
    registerOrganizationRoutes(router);
    registerTemplateRoutes(router);
    registerVolumeRoutes(router);
    registerStripeWebhookRoute(router);
    registerInternalHostRoutes(router);
    return router;
};
const start = async () => {
    const config = await Effect.runPromise(loadConfig());
    const telemetry = initializeTelemetry({
        telemetry: config.telemetry,
        environment: config.environment,
        region: config.defaultRegion
    });
    const database = new Database(Redacted.value(config.databaseUrl));
    const apiAdmission = new PostgresApiAdmission(database, config.apiRateLimit);
    registerDatabasePoolMetrics(() => database.poolSnapshot());
    const apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), config.environment === 'production' ? 'live' : 'test');
    const audit = new AuditService(database);
    const organizations = new OrganizationService(database);
    const projects = new ProjectService(database);
    const deviceAuthorizations = new DeviceAuthorizationService(database, config.deviceVerificationUrl, Redacted.value(config.deviceCodePepper));
    const templateStorage = config.objectStorage
        ? new S3TemplateObjectStore({
            endpoint: config.objectStorage.endpoint,
            region: config.objectStorage.region,
            bucket: config.objectStorage.bucket,
            accessKeyId: Redacted.value(config.objectStorage.accessKeyId),
            secretAccessKey: Redacted.value(config.objectStorage.secretAccessKey),
            sessionToken: config.objectStorage.sessionToken
                ? Redacted.value(config.objectStorage.sessionToken)
                : undefined,
            forcePathStyle: config.objectStorage.forcePathStyle
        })
        : undefined;
    // A raw presigned S3 PUT is never used for customer volume data. The adapter
    // exists only when the complete storage + broker capability configuration is
    // present; otherwise VolumeService preserves its typed 503 fail-closed path.
    const volumeStorage = config.objectStorage && config.volumeBroker
        ? new S3VolumeObjectStore({
            endpoint: config.objectStorage.endpoint,
            region: config.objectStorage.region,
            bucket: config.objectStorage.bucket,
            accessKeyId: Redacted.value(config.objectStorage.accessKeyId),
            secretAccessKey: Redacted.value(config.objectStorage.secretAccessKey),
            sessionToken: config.objectStorage.sessionToken
                ? Redacted.value(config.objectStorage.sessionToken)
                : undefined,
            forcePathStyle: config.objectStorage.forcePathStyle,
            brokerPublicUrl: config.volumeBroker.publicUrl,
            brokerSecret: Redacted.value(config.volumeBroker.secret)
        })
        : undefined;
    const volumes = new VolumeService(database, volumeStorage);
    const volumeDeletionWorker = volumeStorage
        ? new VolumeDeletionWorker(database, volumeStorage)
        : undefined;
    const hostCredentialCipher = new HostCredentialCipher(Redacted.value(config.hostCredentialKey));
    const hosts = new HostService(database, hostCredentialCipher, config.hostCidrs, config.telemetry?.serviceVersion);
    const identityLifecycle = new IdentityLifecycleService(database);
    const hostClient = new NehemiahdClient(new PostgresHostCredentialResolver(database, hostCredentialCipher), fetch, 30_000, config.hostPort);
    const templateTransferClient = config.templateTransfers && config.objectStorage
        ? new NehemiahdTemplateClient(new PostgresHostCredentialResolver(database, hostCredentialCipher), templateObjectOrigins({
            endpoint: config.objectStorage.endpoint,
            bucket: config.objectStorage.bucket,
            forcePathStyle: config.objectStorage.forcePathStyle
        }), fetch, config.templateTransfers.hostTimeoutMs, config.hostPort)
        : undefined;
    const usage = new UsageLedger(database);
    const metering = new AuthoritativeMetering(database);
    const streamAdmission = new StreamAdmissionService(database);
    registerMeteringMetrics(() => metering.health());
    const machines = new MachineService(new PostgresMachineRepository(database), new Scheduler(database), hostClient, usage);
    // The adapter remains absent unless the operator explicitly enables the
    // complete export-first path. This preserves the API's typed 503 when either
    // durable storage or host transfer support is unavailable.
    const templates = new TemplateService(database, machines, templateStorage, templateTransferClient);
    const templateReplicationWorker = templateTransferClient
        ? new TemplateReplicationJob(new PostgresTemplateReplicaRepository(database), templateStorage, templateTransferClient)
        : undefined;
    const services = {
        database,
        readiness: database,
        startedAt: new Date(),
        apiKeys,
        apiAdmission,
        audit,
        organizations,
        projects,
        deviceAuthorizations,
        templates,
        volumes,
        hosts,
        identityLifecycle,
        machines,
        metering,
        streamAdmission,
        gatewayToken: Redacted.value(config.gatewayToken),
        gatewaySecret: Redacted.value(config.gatewaySecret),
        gatewayPublicUrl: config.gatewayPublicUrl,
        previewBaseDomain: config.previewBaseDomain,
        defaultRegion: config.defaultRegion,
        clerkSessionVerifier: config.clerkIssuer
            ? clerkVerifier(config.clerkIssuer, config.clerkAudience)
            : undefined,
        stripeWebhook: process.env.STRIPE_WEBHOOK_SECRET
            ? new StripeWebhookService(database)
            : undefined,
        stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET
    };
    const router = buildRouter();
    const pendingRequestBodies = new PendingRequestBodyAdmission();
    const reconciler = new MachineReconciler(database, hostClient, usage, metering);
    const shutdown = new ControlPlaneShutdown({ graceMs: 30_000, finalizerGraceMs: 10_000 });
    const fleetTimer = setInterval(() => {
        void shutdown.runJob(() => withJobTelemetry('host_stale_marker', () => markStaleHosts(hosts, config.hostStaleAfterMs)).catch((error) => log('error', 'host stale-marker failed', { error })));
    }, Math.max(5_000, config.hostStaleAfterMs / 2));
    const reconcileTimer = setInterval(() => {
        void shutdown.runJob(() => withJobTelemetry('machine_reconciliation', () => reconciler.run()).catch((error) => log('error', 'machine reconciliation failed', { error })));
    }, 10_000);
    const reapTimer = setInterval(() => {
        void shutdown.runJob(() => withJobTelemetry('machine_expiry', () => reapExpiredMachines(database, machines)).catch((error) => log('error', 'machine expiry reaper failed', { error })));
    }, 15_000);
    const gatewayGrantReapTimer = setInterval(() => {
        void shutdown.runJob(() => withJobTelemetry('gateway_grant_expiry', () => reapExpiredGatewayGrants(database)).catch((error) => log('error', 'gateway grant expiry reaper failed', { error })));
    }, 60_000);
    const deviceAuthorizationReapTimer = setInterval(() => {
        void shutdown.runJob(() => withJobTelemetry('device_authorization_retention', () => reapExpiredDeviceAuthorizations(database)).catch((error) => log('error', 'device authorization retention failed', { error })));
    }, 60_000);
    const gatewayStreamReapTimer = setInterval(() => {
        void shutdown.runJob(() => withJobTelemetry('gateway_stream_expiry', () => streamAdmission.reapExpired()).catch((error) => log('error', 'gateway stream lease expiry failed', { error })));
    }, 15_000);
    const usageTimer = setInterval(() => {
        void shutdown.runJob(() => withJobTelemetry('usage_aggregation', () => aggregateUsage(database)).catch((error) => log('error', 'usage aggregation failed', { error })));
    }, 60 * 60 * 1_000);
    const volumeDeletionTimer = volumeDeletionWorker
        ? setInterval(() => {
            void shutdown.runJob(() => withJobTelemetry('volume_deletion', () => volumeDeletionWorker.run()).catch((error) => log('error', 'volume deletion scheduling failed', { error })));
        }, 15_000)
        : undefined;
    const templateReplicationTimer = templateReplicationWorker && config.templateTransfers
        ? setInterval(() => {
            void shutdown.runJob(() => withJobTelemetry('template_replication', () => templateReplicationWorker.runOnce()).catch((error) => log('error', 'template replication scheduling failed', { error })));
        }, config.templateTransfers.replicationIntervalMs)
        : undefined;
    fleetTimer.unref();
    reconcileTimer.unref();
    reapTimer.unref();
    gatewayGrantReapTimer.unref();
    deviceAuthorizationReapTimer.unref();
    gatewayStreamReapTimer.unref();
    usageTimer.unref();
    volumeDeletionTimer?.unref();
    templateReplicationTimer?.unref();
    const server = createServer(controlPlaneHttpServerOptions, (request, response) => {
        void shutdown.runRequest(async () => {
            const started = performance.now();
            const pendingBody = admitPendingRequestBody(request, response, Redacted.value(config.gatewayToken), pendingRequestBodies);
            if (!pendingBody) {
                log('warn', 'request rejected', {
                    method: request.method,
                    status: 429,
                    reason: 'request_body_capacity_reached'
                });
                return;
            }
            const { headers, release: releasePendingBody } = pendingBody;
            try {
                if (volumeStorage?.matchesRequest(request)) {
                    const observedRequest = new Request('https://telemetry.invalid/v1/volume-objects', {
                        method: request.method,
                        headers
                    });
                    const id = requestId(observedRequest);
                    await withControlPlaneRequestTelemetry({
                        request: observedRequest,
                        requestId: id,
                        route: '/v1/volume-objects/:capability'
                    }, async () => {
                        await volumeStorage.handleRequest(request, response);
                        return new Response(null, { status: response.statusCode });
                    });
                    // Capability material lives in a header, and the opaque path ID is
                    // deliberately omitted from telemetry as a second containment layer.
                    log('info', 'volume transfer complete', {
                        requestId: id,
                        method: request.method,
                        path: '/v1/volume-objects/:capability',
                        status: response.statusCode,
                        duration_ms: Math.round(performance.now() - started)
                    });
                    return;
                }
                const webRequest = await incomingRequest(request, headers);
                releasePendingBody();
                const webResponse = await router.handle(webRequest, services);
                await send(webResponse, response);
            }
            catch (error) {
                if (error instanceof HttpRequestError) {
                    closeAfterResponse(request, response);
                    await send(problem(error.status, error.code, error.detail), response);
                    log('warn', 'request rejected', {
                        method: request.method,
                        status: error.status,
                        reason: error.code
                    });
                    return;
                }
                response.statusCode = 500;
                response.setHeader('content-type', 'application/problem+json');
                response.end(JSON.stringify({ title: 'internal_error', status: 500 }));
                log('error', 'request failed', { error });
            }
            finally {
                releasePendingBody();
            }
        }, () => {
            response.statusCode = 503;
            response.setHeader('connection', 'close');
            response.setHeader('retry-after', '1');
            response.setHeader('content-type', 'application/problem+json');
            response.end(JSON.stringify({ title: 'service_unavailable', status: 503 }));
        });
    });
    server.maxConnections = 512;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 100;
    const initiateShutdown = () => shutdown.shutdown({
        server,
        stopTimers: () => {
            for (const timer of [
                fleetTimer,
                reconcileTimer,
                reapTimer,
                gatewayGrantReapTimer,
                deviceAuthorizationReapTimer,
                gatewayStreamReapTimer,
                usageTimer,
                volumeDeletionTimer,
                templateReplicationTimer
            ]) {
                if (timer)
                    clearInterval(timer);
            }
        },
        closeDatabase: () => database.close(),
        closeTelemetry: () => telemetry.shutdown(),
        forceTerminate: () => {
            log('error', 'control plane shutdown deadline exceeded');
            process.exit(1);
        },
        onError: (phase, error) => log('error', 'control plane shutdown phase failed', { reason: phase, error })
    });
    const onSignal = () => {
        void initiateShutdown().catch((error) => {
            log('error', 'control plane shutdown failed', { error });
            process.exit(1);
        });
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    server.listen(config.port, config.host, () => log('info', 'control plane listening', {
        port: config.port,
        environment: config.environment
    }));
};
if (process.env.NODE_ENV !== 'test') {
    await start();
}
//# sourceMappingURL=main.js.map