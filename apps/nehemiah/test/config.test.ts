import { Effect, Either, Redacted } from 'effect';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('control-plane configuration', () => {
	it('has safe local defaults and redacts secrets', async () => {
		const config = await Effect.runPromise(loadConfig({ NODE_ENV: 'test' }));
		expect(config.port).toBe(8081);
		expect(config.objectStorage).toBeUndefined();
		expect(config.volumeBroker).toBeUndefined();
		expect(config.apiRateLimit).toEqual({
			enabled: true,
			failClosed: true,
			windowSeconds: 60,
			preAuthIpRequests: 300,
			preAuthApiKeyRequests: 60,
			principalRequests: 600,
			organizationRequests: 12_000,
			projectRequests: 3_000
		});
		expect(String(config.databaseUrl)).not.toContain('postgres:postgres');
		expect(Redacted.value(config.gatewaySecret)).toBe('dev-gateway-secret');
	});

	it('loads S3-compatible storage only from a complete HTTPS configuration', async () => {
		const config = await Effect.runPromise(
			loadConfig({
				NODE_ENV: 'test',
				NEHEMIAH_S3_ENDPOINT: 'https://objects.example.test',
				NEHEMIAH_S3_REGION: 'auto',
				NEHEMIAH_S3_BUCKET: 'nehemiah-template-artifacts',
				NEHEMIAH_S3_ACCESS_KEY_ID: 'scoped-control-plane-key',
				NEHEMIAH_S3_SECRET_ACCESS_KEY: 'storage-secret-value',
				NEHEMIAH_S3_SESSION_TOKEN: 'temporary-session-token',
				NEHEMIAH_S3_FORCE_PATH_STYLE: 'true'
			})
		);
		expect(config.objectStorage).toMatchObject({
			endpoint: 'https://objects.example.test',
			region: 'auto',
			bucket: 'nehemiah-template-artifacts',
			forcePathStyle: true
		});
		expect(String(config.objectStorage?.accessKeyId)).not.toContain('scoped-control-plane-key');
		expect(Redacted.value(config.objectStorage!.secretAccessKey)).toBe('storage-secret-value');
		expect(Redacted.value(config.objectStorage!.sessionToken!)).toBe('temporary-session-token');
	});

	it('enables the bounded volume broker only from complete storage and capability config', async () => {
		const storage = {
			NEHEMIAH_S3_ENDPOINT: 'https://objects.example.test',
			NEHEMIAH_S3_REGION: 'auto',
			NEHEMIAH_S3_BUCKET: 'nehemiah-volume-artifacts',
			NEHEMIAH_S3_ACCESS_KEY_ID: 'scoped-control-plane-key',
			NEHEMIAH_S3_SECRET_ACCESS_KEY: 'storage-secret-value'
		};
		const brokerSecret = Buffer.alloc(32, 9).toString('base64');
		const configured = await Effect.runPromise(
			loadConfig({
				NODE_ENV: 'test',
				...storage,
				NEHEMIAH_VOLUME_BROKER_URL: 'https://volumes.example.test',
				NEHEMIAH_VOLUME_BROKER_SECRET: brokerSecret
			})
		);
		expect(configured.volumeBroker?.publicUrl).toBe('https://volumes.example.test');
		expect(String(configured.volumeBroker?.secret)).not.toContain(brokerSecret);
		expect(Redacted.value(configured.volumeBroker!.secret)).toBe(brokerSecret);
		const productionRejected = await Effect.runPromise(
			Effect.either(
				loadConfig({
					NODE_ENV: 'production',
					...storage,
					NEHEMIAH_VOLUME_BROKER_URL: 'https://volumes.example.test',
					NEHEMIAH_VOLUME_BROKER_SECRET: brokerSecret
				})
			)
		);
		expect(Either.isLeft(productionRejected)).toBe(true);
		if (Either.isLeft(productionRejected)) {
			expect(productionRejected.left).toMatchObject({
				variable: 'NEHEMIAH_VOLUME_BROKER_URL'
			});
		}

		for (const [environment, variable] of [
			[
				{ NODE_ENV: 'test', NEHEMIAH_VOLUME_BROKER_URL: 'https://volumes.example.test' },
				'NEHEMIAH_VOLUME_BROKER_SECRET'
			],
			[
				{
					NODE_ENV: 'test',
					NEHEMIAH_VOLUME_BROKER_URL: 'https://volumes.example.test',
					NEHEMIAH_VOLUME_BROKER_SECRET: brokerSecret
				},
				'NEHEMIAH_VOLUME_BROKER_URL'
			],
			[
				{
					NODE_ENV: 'test',
					...storage,
					NEHEMIAH_VOLUME_BROKER_URL: 'http://volumes.example.test',
					NEHEMIAH_VOLUME_BROKER_SECRET: brokerSecret
				},
				'NEHEMIAH_VOLUME_BROKER_URL'
			],
			[
				{
					NODE_ENV: 'test',
					...storage,
					NEHEMIAH_VOLUME_BROKER_URL: 'https://volumes.example.test',
					NEHEMIAH_VOLUME_BROKER_SECRET: 'not-a-32-byte-key'
				},
				'NEHEMIAH_VOLUME_BROKER_SECRET'
			]
		] as const) {
			const result = await Effect.runPromise(Effect.either(loadConfig(environment)));
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) expect(result.left).toMatchObject({ variable });
		}
	});

	it('enables host template transfers only with complete durable storage', async () => {
		const storage = {
			NEHEMIAH_S3_ENDPOINT: 'https://objects.example.test',
			NEHEMIAH_S3_REGION: 'auto',
			NEHEMIAH_S3_BUCKET: 'nehemiah-template-artifacts',
			NEHEMIAH_S3_ACCESS_KEY_ID: 'scoped-control-plane-key',
			NEHEMIAH_S3_SECRET_ACCESS_KEY: 'storage-secret-value'
		};
		const enabled = await Effect.runPromise(
			loadConfig({
				NODE_ENV: 'test',
				...storage,
				NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED: 'true',
				NEHEMIAH_TEMPLATE_REPLICATION_INTERVAL_MS: '2500',
				NEHEMIAH_TEMPLATE_HOST_TIMEOUT_MS: '600000'
			})
		);
		expect(enabled.templateTransfers).toEqual({
			replicationIntervalMs: 2_500,
			hostTimeoutMs: 600_000
		});

		const production = await Effect.runPromise(
			Effect.either(
				loadConfig({
					NODE_ENV: 'production',
					...storage,
					NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED: 'true'
				})
			)
		);
		expect(Either.isLeft(production)).toBe(true);
		if (Either.isLeft(production)) {
			expect(production.left).toMatchObject({
				variable: 'NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED'
			});
			expect(production.left.message).toContain('disabled in production');
		}

		for (const environment of [
			{ NODE_ENV: 'test', NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED: 'true' },
			{
				NODE_ENV: 'test',
				...storage,
				NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED: 'false',
				NEHEMIAH_TEMPLATE_HOST_TIMEOUT_MS: '600000'
			},
			{
				NODE_ENV: 'test',
				...storage,
				NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED: 'true',
				NEHEMIAH_TEMPLATE_REPLICATION_INTERVAL_MS: '999'
			}
		]) {
			const result = await Effect.runPromise(Effect.either(loadConfig(environment)));
			expect(Either.isLeft(result)).toBe(true);
		}
	});

	it('rejects partial, insecure, and malformed S3-compatible storage configuration', async () => {
		const partial = await Effect.runPromise(
			Effect.either(
				loadConfig({ NODE_ENV: 'test', NEHEMIAH_S3_ENDPOINT: 'https://objects.example.test' })
			)
		);
		expect(Either.isLeft(partial)).toBe(true);
		if (Either.isLeft(partial)) {
			expect(partial.left).toMatchObject({ variable: 'NEHEMIAH_S3_REGION' });
		}

		const base = {
			NODE_ENV: 'test',
			NEHEMIAH_S3_ENDPOINT: 'https://objects.example.test',
			NEHEMIAH_S3_REGION: 'auto',
			NEHEMIAH_S3_BUCKET: 'nehemiah-template-artifacts',
			NEHEMIAH_S3_ACCESS_KEY_ID: 'scoped-control-plane-key',
			NEHEMIAH_S3_SECRET_ACCESS_KEY: 'storage-secret-value'
		};
		for (const [override, variable] of [
			[{ NEHEMIAH_S3_ENDPOINT: 'http://objects.example.test' }, 'NEHEMIAH_S3_ENDPOINT'],
			[
				{ NEHEMIAH_S3_ENDPOINT: 'https://credential@objects.example.test/path' },
				'NEHEMIAH_S3_ENDPOINT'
			],
			[{ NEHEMIAH_S3_BUCKET: 'Tenant_Bucket' }, 'NEHEMIAH_S3_BUCKET'],
			[{ NEHEMIAH_S3_FORCE_PATH_STYLE: 'yes' }, 'NEHEMIAH_S3_FORCE_PATH_STYLE']
		] as const) {
			const result = await Effect.runPromise(Effect.either(loadConfig({ ...base, ...override })));
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) expect(result.left).toMatchObject({ variable });
		}
	});

	it('requires production database and internal credentials', async () => {
		const result = await Effect.runPromise(Effect.either(loadConfig({ NODE_ENV: 'production' })));
		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left).toMatchObject({ _tag: 'ConfigError', variable: 'DATABASE_URL' });
		}
	});

	it('requires strong, distinct production secrets and a separate untrusted preview site', async () => {
		const production = {
			NODE_ENV: 'production',
			DATABASE_URL: 'postgres://service:secret@database.internal/nehemiah?sslmode=verify-full',
			NEHEMIAH_HOST_CREDENTIAL_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
			NEHEMIAH_GATEWAY_TOKEN: 'gateway-service-'.padEnd(40, 'b'),
			NEHEMIAH_GATEWAY_SECRET: 'capability-signing-'.padEnd(40, 'c'),
			NEHEMIAH_DEVICE_CODE_PEPPER: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=',
			NEHEMIAH_GATEWAY_URL: 'https://gateway.example.com',
			NEHEMIAH_PREVIEW_BASE_DOMAIN: 'example-user-content.net',
			NEHEMIAH_TRUSTED_SITE_DOMAIN: 'example.com',
			CLERK_ISSUER: 'https://clerk.example.com',
			CLERK_AUDIENCE: 'nehemiah-production',
			NEHEMIAH_OTEL_ENABLED: 'true',
			NEHEMIAH_OTEL_ENDPOINT: 'https://otel.example.com',
			NEHEMIAH_OTEL_AUTHORIZATION: 'Bearer production-telemetry-secret',
			NEHEMIAH_SERVICE_VERSION: '2026.08.09',
			NEHEMIAH_INSTANCE_ID: 'control-ca-1-a',
			NEHEMIAH_DEPLOYMENT_ENVIRONMENT: 'production',
			NEHEMIAH_OTEL_EXPORT_INTERVAL_MS: '15000',
			NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS: '10000',
			NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO: '0.25'
		};
		const config = await Effect.runPromise(loadConfig(production));
		expect(config.previewBaseDomain).toBe('example-user-content.net');
		expect(config.deviceVerificationUrl).toBe('https://example.com/dashboard/device');
		expect(String(config.deviceCodePepper)).not.toContain('BAQEBAQE');

		for (const databaseUrl of [
			'postgres://service:secret@database.internal/nehemiah',
			'postgres://service:secret@database.internal/nehemiah?sslmode=require',
			'postgres://service:secret@database.internal/nehemiah?sslmode=verify-full&ssl=false'
		]) {
			const insecureDatabase = await Effect.runPromise(
				Effect.either(loadConfig({ ...production, DATABASE_URL: databaseUrl }))
			);
			expect(Either.isLeft(insecureDatabase)).toBe(true);
			if (Either.isLeft(insecureDatabase)) {
				expect(insecureDatabase.left).toMatchObject({ variable: 'DATABASE_URL' });
			}
		}

		for (const [override, variable] of [
			[{ NEHEMIAH_API_RATE_LIMIT_ENABLED: 'false' }, 'NEHEMIAH_API_RATE_LIMIT_ENABLED'],
			[{ NEHEMIAH_API_RATE_LIMIT_FAIL_CLOSED: 'false' }, 'NEHEMIAH_API_RATE_LIMIT_FAIL_CLOSED'],
			[{ NEHEMIAH_API_RATE_WINDOW_SECONDS: '9' }, 'NEHEMIAH_API_RATE_WINDOW_SECONDS'],
			[{ NEHEMIAH_API_PREAUTH_KEY_REQUESTS: '1000001' }, 'NEHEMIAH_API_PREAUTH_KEY_REQUESTS']
		] as const) {
			const result = await Effect.runPromise(
				Effect.either(loadConfig({ ...production, ...override }))
			);
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) expect(result.left).toMatchObject({ variable });
		}

		const telemetryRequired = await Effect.runPromise(
			Effect.either(
				loadConfig({
					...production,
					NEHEMIAH_OTEL_ENABLED: undefined,
					NEHEMIAH_OTEL_ENDPOINT: undefined,
					NEHEMIAH_OTEL_AUTHORIZATION: undefined,
					NEHEMIAH_SERVICE_VERSION: undefined,
					NEHEMIAH_INSTANCE_ID: undefined,
					NEHEMIAH_DEPLOYMENT_ENVIRONMENT: undefined,
					NEHEMIAH_OTEL_EXPORT_INTERVAL_MS: undefined,
					NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS: undefined,
					NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO: undefined
				})
			)
		);
		expect(Either.isLeft(telemetryRequired)).toBe(true);
		if (Either.isLeft(telemetryRequired)) {
			expect(telemetryRequired.left).toMatchObject({ variable: 'NEHEMIAH_OTEL_ENABLED' });
		}

		const unsafeDeviceUrl = await Effect.runPromise(
			Effect.either(
				loadConfig({
					...production,
					NEHEMIAH_DEVICE_VERIFICATION_URL:
						'https://example.com/dashboard/device?device_code=secret'
				})
			)
		);
		expect(Either.isLeft(unsafeDeviceUrl)).toBe(true);
		if (Either.isLeft(unsafeDeviceUrl)) {
			expect(unsafeDeviceUrl.left).toMatchObject({
				variable: 'NEHEMIAH_DEVICE_VERIFICATION_URL'
			});
		}

		const unsafe = await Effect.runPromise(
			Effect.either(
				loadConfig({ ...production, NEHEMIAH_PREVIEW_BASE_DOMAIN: 'preview.example.com' })
			)
		);
		expect(Either.isLeft(unsafe)).toBe(true);
		if (Either.isLeft(unsafe)) {
			expect(unsafe.left).toMatchObject({ variable: 'NEHEMIAH_PREVIEW_BASE_DOMAIN' });
		}
		const siblingSite = await Effect.runPromise(
			Effect.either(
				loadConfig({
					...production,
					NEHEMIAH_PREVIEW_BASE_DOMAIN: 'preview.example.com',
					NEHEMIAH_TRUSTED_SITE_DOMAIN: 'dashboard.example.com'
				})
			)
		);
		expect(Either.isLeft(siblingSite)).toBe(true);
		if (Either.isLeft(siblingSite)) {
			expect(siblingSite.left).toMatchObject({ variable: 'NEHEMIAH_PREVIEW_BASE_DOMAIN' });
		}

		const reusedEncryptionKey = await Effect.runPromise(
			Effect.either(
				loadConfig({
					...production,
					NEHEMIAH_GATEWAY_SECRET: production.NEHEMIAH_HOST_CREDENTIAL_KEY
				})
			)
		);
		expect(Either.isLeft(reusedEncryptionKey)).toBe(true);
		if (Either.isLeft(reusedEncryptionKey)) {
			expect(reusedEncryptionKey.left).toMatchObject({ variable: 'NEHEMIAH_GATEWAY_SECRET' });
		}

		const reusedVolumeCapabilityKey = await Effect.runPromise(
			Effect.either(
				loadConfig({
					...production,
					NEHEMIAH_S3_ENDPOINT: 'https://objects.example.test',
					NEHEMIAH_S3_REGION: 'ca-central-1',
					NEHEMIAH_S3_BUCKET: 'nehemiah-production-artifacts',
					NEHEMIAH_S3_ACCESS_KEY_ID: 'production-scoped-storage',
					NEHEMIAH_S3_SECRET_ACCESS_KEY: 'production-storage-secret',
					NEHEMIAH_VOLUME_BROKER_URL: 'https://api.example.com',
					NEHEMIAH_VOLUME_BROKER_SECRET: production.NEHEMIAH_HOST_CREDENTIAL_KEY
				})
			)
		);
		expect(Either.isLeft(reusedVolumeCapabilityKey)).toBe(true);
		if (Either.isLeft(reusedVolumeCapabilityKey)) {
			expect(reusedVolumeCapabilityKey.left).toMatchObject({
				variable: 'NEHEMIAH_VOLUME_BROKER_URL'
			});
		}
	});

	it('enables OTLP exporters only from complete, TLS-only configuration', async () => {
		const environment = {
			NODE_ENV: 'test',
			NEHEMIAH_OTEL_ENABLED: 'true',
			NEHEMIAH_OTEL_ENDPOINT: 'https://otel.example.test',
			NEHEMIAH_OTEL_AUTHORIZATION: 'Bearer telemetry-secret-value',
			NEHEMIAH_SERVICE_VERSION: '2026.08.09',
			NEHEMIAH_INSTANCE_ID: 'control-ca-1-a',
			NEHEMIAH_DEPLOYMENT_ENVIRONMENT: 'test',
			NEHEMIAH_OTEL_EXPORT_INTERVAL_MS: '15000',
			NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS: '10000',
			NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO: '0.25'
		};
		const config = await Effect.runPromise(loadConfig(environment));
		expect(config.telemetry).toMatchObject({
			endpoint: 'https://otel.example.test',
			serviceVersion: '2026.08.09',
			instanceId: 'control-ca-1-a',
			deploymentEnvironment: 'test',
			exportIntervalMs: 15_000,
			exportTimeoutMs: 10_000,
			traceSampleRatio: 0.25
		});
		expect(String(config.telemetry?.authorization)).not.toContain('telemetry-secret-value');

		for (const override of [
			{ NEHEMIAH_OTEL_ENABLED: 'false' },
			{ NEHEMIAH_OTEL_ENABLED: '1' },
			{ NEHEMIAH_OTEL_ENDPOINT: 'http://otel.example.test' },
			{ NEHEMIAH_OTEL_ENDPOINT: 'https://192.0.2.1' },
			{ NEHEMIAH_OTEL_ENDPOINT: 'https://[2001:db8::1]' },
			{ NEHEMIAH_OTEL_ENDPOINT: 'https://user@otel.example.test/path' },
			{ NEHEMIAH_INSTANCE_ID: '192.0.2.1' },
			{ NEHEMIAH_DEFAULT_REGION: '192.0.2.1' },
			{ NEHEMIAH_OTEL_AUTHORIZATION: 'Bearer secret with spaces' },
			{ NEHEMIAH_DEPLOYMENT_ENVIRONMENT: 'qa' },
			{ NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS: '15000' },
			{ NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO: 'NaN' },
			{ NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO: '1.1' }
		]) {
			const result = await Effect.runPromise(
				Effect.either(loadConfig({ ...environment, ...override }))
			);
			expect(Either.isLeft(result)).toBe(true);
		}
	});

	it('rejects exporter tuning unless telemetry is explicitly enabled', async () => {
		const result = await Effect.runPromise(
			Effect.either(
				loadConfig({
					NODE_ENV: 'test',
					NEHEMIAH_OTEL_ENDPOINT: 'https://otel.example.test'
				})
			)
		);
		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left).toMatchObject({ variable: 'NEHEMIAH_OTEL_ENABLED' });
		}
	});
});
