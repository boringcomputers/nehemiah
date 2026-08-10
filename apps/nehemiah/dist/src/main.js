import { createServer } from 'node:http';
import { Effect, Redacted } from 'effect';
import { ApiKeyService, PostgresApiKeyStore } from './auth/api-key.js';
import { clerkVerifier } from './auth/clerk.js';
import { NehemiahdClient } from './clients/nehemiahd.js';
import { loadConfig } from './config.js';
import { Database } from './db/client.js';
import { HostService } from './domain/hosts.js';
import { MachineService, PostgresMachineRepository } from './domain/machines.js';
import { OrganizationService } from './domain/organizations.js';
import { healthz, readyz } from './http/health.js';
import { openapi } from './http/openapi.js';
import { Router } from './http/router.js';
import { registerApiKeyRoutes } from './http/routes/api-keys.js';
import { registerInternalHostRoutes } from './http/routes/internal-hosts.js';
import { registerMachineRoutes } from './http/routes/machines.js';
import { markStaleHosts } from './jobs/mark-stale-hosts.js';
import { MachineReconciler } from './jobs/reconcile-machines.js';
import { reapExpiredMachines } from './jobs/reap-expired-machines.js';
import { Scheduler } from './scheduler/scheduler.js';
import { log } from './telemetry.js';
const incomingRequest = async (request) => {
    const host = request.headers.host ?? 'localhost';
    const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value))
            value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined)
            headers.set(name, value);
    }
    let body;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > 1_048_576)
                throw new Error('request body is too large');
            chunks.push(buffer);
        }
        body = Buffer.concat(chunks);
    }
    return new Request(`${protocol}://${host}${request.url ?? '/'}`, {
        method: request.method,
        headers,
        body: body
    });
};
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
    registerInternalHostRoutes(router);
    return router;
};
const start = async () => {
    const config = await Effect.runPromise(loadConfig());
    const database = new Database(Redacted.value(config.databaseUrl));
    const apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), config.environment === 'production' ? 'live' : 'test');
    const organizations = new OrganizationService(database);
    const hosts = new HostService(database);
    const hostClient = new NehemiahdClient(Redacted.value(config.internalToken));
    const machines = new MachineService(new PostgresMachineRepository(database), new Scheduler(database), hostClient);
    const services = {
        database,
        readiness: database,
        startedAt: new Date(),
        apiKeys,
        organizations,
        hosts,
        machines,
        internalToken: Redacted.value(config.internalToken),
        gatewayToken: Redacted.value(config.gatewayToken),
        gatewaySecret: Redacted.value(config.gatewayToken),
        gatewayPublicUrl: process.env.NEHEMIAH_GATEWAY_URL ?? 'http://localhost:8082',
        clerkSessionVerifier: config.clerkIssuer
            ? clerkVerifier(config.clerkIssuer, config.clerkAudience)
            : undefined
    };
    const router = buildRouter();
    const reconciler = new MachineReconciler(database, hostClient);
    const fleetTimer = setInterval(() => {
        void markStaleHosts(hosts, config.hostStaleAfterMs).catch((error) => log('error', 'host stale-marker failed', { error: String(error) }));
    }, Math.max(5_000, config.hostStaleAfterMs / 2));
    const reconcileTimer = setInterval(() => {
        void reconciler.run().catch((error) => log('error', 'machine reconciliation failed', { error: String(error) }));
    }, 10_000);
    const reapTimer = setInterval(() => {
        void reapExpiredMachines(database, machines).catch((error) => log('error', 'machine expiry reaper failed', { error: String(error) }));
    }, 15_000);
    fleetTimer.unref();
    reconcileTimer.unref();
    reapTimer.unref();
    const server = createServer(async (request, response) => {
        const started = performance.now();
        try {
            const webRequest = await incomingRequest(request);
            const webResponse = await router.handle(webRequest, services);
            await send(webResponse, response);
            log('info', 'request complete', {
                requestId: webResponse.headers.get('x-request-id') ?? undefined,
                method: request.method,
                path: new URL(webRequest.url).pathname,
                status: webResponse.status,
                duration_ms: Math.round(performance.now() - started)
            });
        }
        catch (error) {
            response.statusCode = 500;
            response.setHeader('content-type', 'application/problem+json');
            response.end(JSON.stringify({ title: 'internal_error', status: 500 }));
            log('error', 'request failed', { error: String(error) });
        }
    });
    const shutdown = async () => {
        clearInterval(fleetTimer);
        clearInterval(reconcileTimer);
        clearInterval(reapTimer);
        server.close();
        await database.close();
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
    server.listen(config.port, config.host, () => log('info', 'control plane listening', {
        host: config.host,
        port: config.port,
        environment: config.environment
    }));
};
if (process.env.NODE_ENV !== 'test') {
    await start();
}
//# sourceMappingURL=main.js.map