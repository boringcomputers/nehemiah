import { describe, expect, it } from 'vitest';
import {
	safeLogRecord,
	telemetryResourceAttributes,
	requestId,
	type LogContext
} from '../src/telemetry.js';

describe('telemetry redaction', () => {
	it('keeps only normalized, bounded fields', () => {
		const secret = 'customer-super-secret';
		const unsafeContext = {
			requestId: 'request-safe-123',
			method: 'GET',
			path: `/v1/machines/${secret}?token=${secret}`,
			status: 503,
			error: new Error(`remote 10.64.0.5 said ${secret}`),
			// Verify arbitrary headers/body/command-like fields cannot cross the allowlist.
			authorization: `Bearer ${secret}`,
			body: secret,
			command: `cat ${secret}`
		} as LogContext & Record<string, unknown>;
		const record = safeLogRecord(
			'error',
			'request failed',
			unsafeContext,
			new Date('2026-08-09T00:00:00.000Z')
		);
		expect(record).toMatchObject({
			timestamp: '2026-08-09T00:00:00.000Z',
			level: 'error',
			message: 'request failed',
			requestId: 'request-safe-123',
			method: 'GET',
			status: 503,
			error_type: 'Error'
		});
		expect(record).not.toHaveProperty('route');
		expect(JSON.stringify(record)).not.toContain(secret);
		expect(JSON.stringify(record)).not.toContain('10.64.0.5');
	});

	it('accepts a route template but rejects a raw dynamic path', () => {
		expect(safeLogRecord('info', 'complete', { path: '/v1/machines/:id' })).toHaveProperty(
			'route',
			'/v1/machines/:id'
		);
		expect(
			safeLogRecord('info', 'complete', { path: '/v1/machines/customer-id?token=secret' })
		).not.toHaveProperty('route');
		expect(safeLogRecord('info', 'ready', { environment: 'staging' })).toHaveProperty(
			'environment',
			'staging'
		);
	});

	it('exports only fixed resource identity attributes', () => {
		const canary = 'NEHEMIAH-REDACTION-CANARY-7f91';
		const configuration = {
			serviceVersion: '2026.08.09',
			instanceId: 'control-ca-1-a',
			deploymentEnvironment: 'staging' as const,
			authorization: `Bearer ${canary}`,
			customerContent: canary,
			clientAddress: '203.0.113.42'
		};
		const attributes = telemetryResourceAttributes(configuration, 'ca-central-1');
		expect(attributes).toEqual({
			'service.name': 'nehemiah-control',
			'service.version': '2026.08.09',
			'service.instance.id': 'control-ca-1-a',
			'deployment.environment.name': 'staging',
			'cloud.region': 'ca-central-1'
		});
		expect(JSON.stringify(attributes)).not.toContain(canary);
		expect(JSON.stringify(attributes)).not.toContain('203.0.113.42');
	});

	it('does not trust customer content as a request identifier', () => {
		const supplied = 'customer-secret-request-id';
		const generated = requestId(
			new Request('https://api.example.test/v1/machines', {
				headers: { 'x-request-id': supplied }
			})
		);
		expect(generated).not.toBe(supplied);
		expect(requestId(new Request('https://api.example.test'))).toMatch(
			/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
		);
	});
});
