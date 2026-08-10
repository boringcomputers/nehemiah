import { isIP } from 'node:net';
import { Data, Effect, Redacted } from 'effect';
import type { ApiRateLimitConfig } from './auth/api-admission.js';
import { productionDatabaseUrlIssue } from './db/url.js';

export type Environment = 'development' | 'test' | 'production';

export interface S3ObjectStorageConfig {
	readonly endpoint: string;
	readonly region: string;
	readonly bucket: string;
	readonly accessKeyId: Redacted.Redacted<string>;
	readonly secretAccessKey: Redacted.Redacted<string>;
	readonly sessionToken?: Redacted.Redacted<string>;
	readonly forcePathStyle: boolean;
}

export interface TemplateTransferConfig {
	readonly replicationIntervalMs: number;
	readonly hostTimeoutMs: number;
}

export interface VolumeBrokerConfig {
	readonly publicUrl: string;
	readonly secret: Redacted.Redacted<string>;
}

export interface TelemetryConfig {
	readonly endpoint: string;
	readonly authorization: Redacted.Redacted<string>;
	readonly serviceVersion: string;
	readonly instanceId: string;
	readonly deploymentEnvironment: 'development' | 'test' | 'staging' | 'production';
	readonly exportIntervalMs: number;
	readonly exportTimeoutMs: number;
	readonly traceSampleRatio: number;
}

export interface ServiceConfig {
	readonly environment: Environment;
	readonly host: string;
	readonly port: number;
	readonly databaseUrl: Redacted.Redacted<string>;
	readonly hostCredentialKey: Redacted.Redacted<string>;
	readonly gatewayToken: Redacted.Redacted<string>;
	readonly gatewaySecret: Redacted.Redacted<string>;
	readonly deviceCodePepper: Redacted.Redacted<string>;
	readonly gatewayPublicUrl: string;
	readonly deviceVerificationUrl: string;
	readonly previewBaseDomain?: string;
	readonly trustedSiteDomain?: string;
	readonly hostCidrs: ReadonlyArray<string>;
	readonly hostPort: number;
	readonly clerkIssuer?: string;
	readonly clerkAudience?: string;
	readonly hostStaleAfterMs: number;
	readonly defaultRegion: string;
	readonly objectStorage?: S3ObjectStorageConfig;
	readonly templateTransfers?: TemplateTransferConfig;
	readonly volumeBroker?: VolumeBrokerConfig;
	readonly telemetry?: TelemetryConfig;
	readonly apiRateLimit: ApiRateLimitConfig;
}

export class ConfigError extends Data.TaggedError('ConfigError')<{
	readonly variable: string;
	readonly message: string;
}> {}

const integer = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ConfigError({ variable: name, message: 'must be a positive integer' });
	}
	return value;
};

const boolean = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new ConfigError({ variable: name, message: 'must be true or false' });
};

const finiteNumber = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new ConfigError({ variable: name, message: 'must be a finite number' });
	}
	return value;
};

const secret = (
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: string,
	required: boolean
): Redacted.Redacted<string> => {
	const value = env[name] || fallback;
	if (required && !env[name]) {
		throw new ConfigError({ variable: name, message: 'is required in production' });
	}
	return Redacted.make(value);
};

const requireStrongProductionSecret = (
	production: boolean,
	name: string,
	value: Redacted.Redacted<string>
): void => {
	if (production && Redacted.value(value).length < 32) {
		throw new ConfigError({
			variable: name,
			message: 'must contain at least 32 characters'
		});
	}
};

const validateCredentialKey = (value: Redacted.Redacted<string>): void => {
	const encoded = Redacted.value(value);
	const decoded = Buffer.from(encoded, 'base64');
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || decoded.byteLength !== 32) {
		throw new ConfigError({
			variable: 'NEHEMIAH_HOST_CREDENTIAL_KEY',
			message: 'must be a base64-encoded 32-byte key'
		});
	}
};

const validateDeviceCodePepper = (value: Redacted.Redacted<string>): void => {
	const encoded = Redacted.value(value);
	const decoded = Buffer.from(encoded, 'base64');
	if (
		!/^[A-Za-z0-9+/]{43}=$/.test(encoded) ||
		decoded.byteLength !== 32 ||
		decoded.toString('base64') !== encoded
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_DEVICE_CODE_PEPPER',
			message: 'must be a canonical base64-encoded 32-byte key'
		});
	}
};

// This is deliberately more conservative than a public-suffix lookup. Requiring
// different final two-label suffixes catches sibling subdomains on normal
// registrable domains and also fails closed for multi-label public suffixes
// (operators can always use the documented dedicated .net-style preview site).
const siteBoundarySuffix = (domain: string): string => domain.split('.').slice(-2).join('.');

const requiredStorageValue = (env: NodeJS.ProcessEnv, name: string): string => {
	const value = env[name];
	if (!value) {
		throw new ConfigError({
			variable: name,
			message: 'is required when S3-compatible object storage is configured'
		});
	}
	return value;
};

const loadObjectStorage = (env: NodeJS.ProcessEnv): S3ObjectStorageConfig | undefined => {
	const variables = [
		'NEHEMIAH_S3_ENDPOINT',
		'NEHEMIAH_S3_REGION',
		'NEHEMIAH_S3_BUCKET',
		'NEHEMIAH_S3_ACCESS_KEY_ID',
		'NEHEMIAH_S3_SECRET_ACCESS_KEY',
		'NEHEMIAH_S3_SESSION_TOKEN',
		'NEHEMIAH_S3_FORCE_PATH_STYLE'
	] as const;
	if (!variables.some((name) => env[name] !== undefined)) return undefined;

	const endpointValue = requiredStorageValue(env, 'NEHEMIAH_S3_ENDPOINT');
	let endpoint: URL;
	try {
		endpoint = new URL(endpointValue);
	} catch {
		throw new ConfigError({
			variable: 'NEHEMIAH_S3_ENDPOINT',
			message: 'must be an origin-only HTTPS URL'
		});
	}
	if (
		endpoint.protocol !== 'https:' ||
		endpoint.username ||
		endpoint.password ||
		endpoint.pathname !== '/' ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_S3_ENDPOINT',
			message: 'must be an origin-only HTTPS URL'
		});
	}

	const region = requiredStorageValue(env, 'NEHEMIAH_S3_REGION');
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(region)) {
		throw new ConfigError({
			variable: 'NEHEMIAH_S3_REGION',
			message: 'must be a valid S3 signing region'
		});
	}
	const bucket = requiredStorageValue(env, 'NEHEMIAH_S3_BUCKET');
	if (
		!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
		bucket.includes('..') ||
		bucket.includes('.-') ||
		bucket.includes('-.') ||
		/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_S3_BUCKET',
			message: 'must be a valid DNS-compatible S3 bucket name'
		});
	}

	const accessKeyId = requiredStorageValue(env, 'NEHEMIAH_S3_ACCESS_KEY_ID');
	if (accessKeyId.length > 256 || /\s|[\u0000-\u001f\u007f]/.test(accessKeyId)) {
		throw new ConfigError({
			variable: 'NEHEMIAH_S3_ACCESS_KEY_ID',
			message: 'must be a non-whitespace credential identifier of at most 256 characters'
		});
	}
	const secretAccessKey = requiredStorageValue(env, 'NEHEMIAH_S3_SECRET_ACCESS_KEY');
	if (
		secretAccessKey.length < 8 ||
		secretAccessKey.length > 256 ||
		/[\u0000-\u001f\u007f]/.test(secretAccessKey)
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_S3_SECRET_ACCESS_KEY',
			message: 'must contain 8-256 non-control characters'
		});
	}
	const sessionToken = env.NEHEMIAH_S3_SESSION_TOKEN;
	if (
		sessionToken !== undefined &&
		(!sessionToken || sessionToken.length > 4_096 || /[\u0000-\u001f\u007f]/.test(sessionToken))
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_S3_SESSION_TOKEN',
			message: 'must be a non-empty token of at most 4096 non-control characters'
		});
	}

	return {
		endpoint: endpoint.origin,
		region,
		bucket,
		accessKeyId: Redacted.make(accessKeyId),
		secretAccessKey: Redacted.make(secretAccessKey),
		sessionToken: sessionToken === undefined ? undefined : Redacted.make(sessionToken),
		forcePathStyle: boolean(env, 'NEHEMIAH_S3_FORCE_PATH_STYLE', false)
	};
};

const loadTemplateTransfers = (
	env: NodeJS.ProcessEnv,
	objectStorage: S3ObjectStorageConfig | undefined,
	production: boolean
): TemplateTransferConfig | undefined => {
	const configured = [
		'NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED',
		'NEHEMIAH_TEMPLATE_REPLICATION_INTERVAL_MS',
		'NEHEMIAH_TEMPLATE_HOST_TIMEOUT_MS'
	].some((name) => env[name] !== undefined);
	if (!configured) return undefined;
	const enabled = boolean(env, 'NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED', false);
	if (!enabled) {
		if (
			env.NEHEMIAH_TEMPLATE_REPLICATION_INTERVAL_MS !== undefined ||
			env.NEHEMIAH_TEMPLATE_HOST_TIMEOUT_MS !== undefined
		) {
			throw new ConfigError({
				variable: 'NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED',
				message: 'must be true before template transfer tuning is configured'
			});
		}
		return undefined;
	}
	if (production) {
		throw new ConfigError({
			variable: 'NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED',
			message:
				'managed custom-template publication is disabled in production until aggregate tenant and host-cache quotas plus durable eviction are enforced'
		});
	}
	if (!objectStorage) {
		throw new ConfigError({
			variable: 'NEHEMIAH_TEMPLATE_TRANSFERS_ENABLED',
			message: 'requires the complete S3-compatible object storage configuration'
		});
	}
	const replicationIntervalMs = integer(env, 'NEHEMIAH_TEMPLATE_REPLICATION_INTERVAL_MS', 5_000);
	if (replicationIntervalMs < 1_000 || replicationIntervalMs > 60_000) {
		throw new ConfigError({
			variable: 'NEHEMIAH_TEMPLATE_REPLICATION_INTERVAL_MS',
			message: 'must be between 1000 and 60000'
		});
	}
	const hostTimeoutMs = integer(env, 'NEHEMIAH_TEMPLATE_HOST_TIMEOUT_MS', 15 * 60 * 1_000);
	if (hostTimeoutMs < 60_000 || hostTimeoutMs > 30 * 60 * 1_000) {
		throw new ConfigError({
			variable: 'NEHEMIAH_TEMPLATE_HOST_TIMEOUT_MS',
			message: 'must be between 60000 and 1800000'
		});
	}
	return { replicationIntervalMs, hostTimeoutMs };
};

const loadVolumeBroker = (
	env: NodeJS.ProcessEnv,
	objectStorage: S3ObjectStorageConfig | undefined,
	production: boolean
): VolumeBrokerConfig | undefined => {
	const variables = ['NEHEMIAH_VOLUME_BROKER_URL', 'NEHEMIAH_VOLUME_BROKER_SECRET'] as const;
	if (!variables.some((name) => env[name] !== undefined)) return undefined;
	if (production) {
		throw new ConfigError({
			variable: 'NEHEMIAH_VOLUME_BROKER_URL',
			message:
				'managed volume transfers are disabled in production until durable volume/revision counts and global transfer admission are enforced'
		});
	}
	for (const name of variables) {
		if (!env[name]) {
			throw new ConfigError({
				variable: name,
				message: 'is required when the bounded volume broker is configured'
			});
		}
	}
	if (!objectStorage) {
		throw new ConfigError({
			variable: 'NEHEMIAH_VOLUME_BROKER_URL',
			message: 'requires the complete S3-compatible object storage configuration'
		});
	}
	let publicUrl: URL;
	try {
		publicUrl = new URL(env.NEHEMIAH_VOLUME_BROKER_URL!);
	} catch {
		throw new ConfigError({
			variable: 'NEHEMIAH_VOLUME_BROKER_URL',
			message: 'must be an origin-only HTTPS URL'
		});
	}
	if (
		publicUrl.protocol !== 'https:' ||
		publicUrl.username ||
		publicUrl.password ||
		publicUrl.pathname !== '/' ||
		publicUrl.search ||
		publicUrl.hash
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_VOLUME_BROKER_URL',
			message: 'must be an origin-only HTTPS URL'
		});
	}
	const encodedSecret = env.NEHEMIAH_VOLUME_BROKER_SECRET!;
	const decodedSecret = Buffer.from(encodedSecret, 'base64');
	if (
		!/^[A-Za-z0-9+/]{43}=$/.test(encodedSecret) ||
		decodedSecret.byteLength !== 32 ||
		decodedSecret.toString('base64') !== encodedSecret
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_VOLUME_BROKER_SECRET',
			message: 'must be a canonical base64-encoded 32-byte key'
		});
	}
	return { publicUrl: publicUrl.origin, secret: Redacted.make(encodedSecret) };
};

const loadTelemetry = (env: NodeJS.ProcessEnv): TelemetryConfig | undefined => {
	const tuning = [
		'NEHEMIAH_OTEL_ENDPOINT',
		'NEHEMIAH_OTEL_AUTHORIZATION',
		'NEHEMIAH_SERVICE_VERSION',
		'NEHEMIAH_INSTANCE_ID',
		'NEHEMIAH_DEPLOYMENT_ENVIRONMENT',
		'NEHEMIAH_OTEL_EXPORT_INTERVAL_MS',
		'NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS',
		'NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO'
	] as const;
	const configured =
		env.NEHEMIAH_OTEL_ENABLED !== undefined || tuning.some((name) => env[name] !== undefined);
	if (!configured) return undefined;
	const enabled = boolean(env, 'NEHEMIAH_OTEL_ENABLED', false);
	if (!enabled) {
		if (tuning.some((name) => env[name] !== undefined)) {
			throw new ConfigError({
				variable: 'NEHEMIAH_OTEL_ENABLED',
				message: 'must be true before OTLP exporter settings are configured'
			});
		}
		return undefined;
	}

	const endpointValue = env.NEHEMIAH_OTEL_ENDPOINT;
	let endpoint: URL;
	try {
		endpoint = new URL(endpointValue ?? '');
	} catch {
		throw new ConfigError({
			variable: 'NEHEMIAH_OTEL_ENDPOINT',
			message: 'must be an origin-only HTTPS URL with a DNS hostname'
		});
	}
	if (
		endpoint.protocol !== 'https:' ||
		isIP(endpoint.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
		endpoint.username ||
		endpoint.password ||
		endpoint.pathname !== '/' ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_OTEL_ENDPOINT',
			message: 'must be an origin-only HTTPS URL with a DNS hostname'
		});
	}
	const authorization = env.NEHEMIAH_OTEL_AUTHORIZATION ?? '';
	if (
		authorization.length < 16 ||
		authorization.length > 4_096 ||
		!/^[A-Za-z][A-Za-z0-9_-]{0,31} [\x21-\x7e]+$/.test(authorization)
	) {
		throw new ConfigError({
			variable: 'NEHEMIAH_OTEL_AUTHORIZATION',
			message:
				'must be a 16-4096 character HTTP authorization value without whitespace in its credential'
		});
	}
	const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
	const serviceVersion = env.NEHEMIAH_SERVICE_VERSION ?? '';
	if (!identityPattern.test(serviceVersion)) {
		throw new ConfigError({
			variable: 'NEHEMIAH_SERVICE_VERSION',
			message: 'must be an immutable 1-128 character release identifier'
		});
	}
	const instanceId = env.NEHEMIAH_INSTANCE_ID ?? '';
	if (!identityPattern.test(instanceId) || isIP(instanceId) !== 0) {
		throw new ConfigError({
			variable: 'NEHEMIAH_INSTANCE_ID',
			message: 'must be a stable non-IP 1-128 character instance identifier'
		});
	}
	const deploymentEnvironment = env.NEHEMIAH_DEPLOYMENT_ENVIRONMENT ?? '';
	if (!['development', 'test', 'staging', 'production'].includes(deploymentEnvironment)) {
		throw new ConfigError({
			variable: 'NEHEMIAH_DEPLOYMENT_ENVIRONMENT',
			message: 'must be development, test, staging, or production'
		});
	}
	const exportIntervalMs = integer(env, 'NEHEMIAH_OTEL_EXPORT_INTERVAL_MS', 15_000);
	if (exportIntervalMs < 5_000 || exportIntervalMs > 300_000) {
		throw new ConfigError({
			variable: 'NEHEMIAH_OTEL_EXPORT_INTERVAL_MS',
			message: 'must be between 5000 and 300000'
		});
	}
	const exportTimeoutMs = integer(env, 'NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS', 10_000);
	if (exportTimeoutMs < 1_000 || exportTimeoutMs > 30_000 || exportTimeoutMs >= exportIntervalMs) {
		throw new ConfigError({
			variable: 'NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS',
			message: 'must be between 1000 and 30000 and less than the export interval'
		});
	}
	const traceSampleRatio = finiteNumber(env, 'NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO', 0.1);
	if (traceSampleRatio < 0.001 || traceSampleRatio > 1) {
		throw new ConfigError({
			variable: 'NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO',
			message: 'must be between 0.001 and 1'
		});
	}
	return {
		endpoint: endpoint.origin,
		authorization: Redacted.make(authorization),
		serviceVersion,
		instanceId,
		deploymentEnvironment: deploymentEnvironment as TelemetryConfig['deploymentEnvironment'],
		exportIntervalMs,
		exportTimeoutMs,
		traceSampleRatio
	};
};

const loadApiRateLimit = (env: NodeJS.ProcessEnv, production: boolean): ApiRateLimitConfig => {
	const enabled = boolean(env, 'NEHEMIAH_API_RATE_LIMIT_ENABLED', true);
	const failClosed = boolean(env, 'NEHEMIAH_API_RATE_LIMIT_FAIL_CLOSED', true);
	if (production && !enabled) {
		throw new ConfigError({
			variable: 'NEHEMIAH_API_RATE_LIMIT_ENABLED',
			message: 'must be true in production'
		});
	}
	if (production && !failClosed) {
		throw new ConfigError({
			variable: 'NEHEMIAH_API_RATE_LIMIT_FAIL_CLOSED',
			message: 'must be true in production'
		});
	}
	const windowSeconds = integer(env, 'NEHEMIAH_API_RATE_WINDOW_SECONDS', 60);
	if (windowSeconds < 10 || windowSeconds > 3_600) {
		throw new ConfigError({
			variable: 'NEHEMIAH_API_RATE_WINDOW_SECONDS',
			message: 'must be between 10 and 3600'
		});
	}
	const boundedLimit = (name: string, fallback: number): number => {
		const value = integer(env, name, fallback);
		if (value > 1_000_000) {
			throw new ConfigError({ variable: name, message: 'must be between 1 and 1000000' });
		}
		return value;
	};
	return {
		enabled,
		failClosed,
		windowSeconds,
		preAuthIpRequests: boundedLimit('NEHEMIAH_API_PREAUTH_IP_REQUESTS', 300),
		preAuthApiKeyRequests: boundedLimit('NEHEMIAH_API_PREAUTH_KEY_REQUESTS', 60),
		principalRequests: boundedLimit('NEHEMIAH_API_PRINCIPAL_REQUESTS', 600),
		organizationRequests: boundedLimit('NEHEMIAH_API_ORGANIZATION_REQUESTS', 12_000),
		projectRequests: boundedLimit('NEHEMIAH_API_PROJECT_REQUESTS', 3_000)
	};
};

/** Load and validate configuration inside Effect so startup failures are typed. */
export const loadConfig = (
	env: NodeJS.ProcessEnv = process.env
): Effect.Effect<ServiceConfig, ConfigError> =>
	Effect.try({
		try: () => {
			const environment = (env.NODE_ENV ?? 'development') as Environment;
			if (!['development', 'test', 'production'].includes(environment)) {
				throw new ConfigError({
					variable: 'NODE_ENV',
					message: 'must be development, test, or production'
				});
			}
			const production = environment === 'production';
			const apiRateLimit = loadApiRateLimit(env, production);
			const objectStorage = loadObjectStorage(env);
			const templateTransfers = loadTemplateTransfers(env, objectStorage, production);
			const volumeBroker = loadVolumeBroker(env, objectStorage, production);
			const telemetry = loadTelemetry(env);
			const defaultRegion = env.NEHEMIAH_DEFAULT_REGION ?? 'ca-tor-1';
			if (
				telemetry &&
				(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(defaultRegion) || isIP(defaultRegion) !== 0)
			) {
				throw new ConfigError({
					variable: 'NEHEMIAH_DEFAULT_REGION',
					message: 'must be a bounded non-IP region identifier when telemetry is enabled'
				});
			}
			if (
				production &&
				telemetry &&
				!['staging', 'production'].includes(telemetry.deploymentEnvironment)
			) {
				throw new ConfigError({
					variable: 'NEHEMIAH_DEPLOYMENT_ENVIRONMENT',
					message: 'must be staging or production when NODE_ENV=production'
				});
			}
			const databaseUrl = secret(
				env,
				'DATABASE_URL',
				'postgres://postgres:postgres@127.0.0.1:5432/nehemiah',
				production
			);
			if (production) {
				const issue = productionDatabaseUrlIssue(Redacted.value(databaseUrl));
				if (issue) throw new ConfigError({ variable: 'DATABASE_URL', message: issue });
			}
			const hostCredentialKey = secret(
				env,
				'NEHEMIAH_HOST_CREDENTIAL_KEY',
				'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
				production
			);
			validateCredentialKey(hostCredentialKey);
			const gatewayToken = secret(env, 'NEHEMIAH_GATEWAY_TOKEN', 'dev-gateway-token', production);
			const gatewaySecret = secret(
				env,
				'NEHEMIAH_GATEWAY_SECRET',
				'dev-gateway-secret',
				production
			);
			const deviceCodePepper = secret(
				env,
				'NEHEMIAH_DEVICE_CODE_PEPPER',
				'bmVoZW1pYWgtZGV2aWNlLWNvZGUtcGVwcGVyLWRldiE=',
				production
			);
			validateDeviceCodePepper(deviceCodePepper);
			requireStrongProductionSecret(production, 'NEHEMIAH_GATEWAY_TOKEN', gatewayToken);
			requireStrongProductionSecret(production, 'NEHEMIAH_GATEWAY_SECRET', gatewaySecret);
			if (production && !telemetry) {
				throw new ConfigError({
					variable: 'NEHEMIAH_OTEL_ENABLED',
					message: 'must be true with a complete exporter configuration in production'
				});
			}
			const platformSecrets: ReadonlyArray<readonly [string, string]> = [
				['NEHEMIAH_HOST_CREDENTIAL_KEY', Redacted.value(hostCredentialKey)],
				['NEHEMIAH_GATEWAY_TOKEN', Redacted.value(gatewayToken)],
				['NEHEMIAH_GATEWAY_SECRET', Redacted.value(gatewaySecret)],
				['NEHEMIAH_DEVICE_CODE_PEPPER', Redacted.value(deviceCodePepper)],
				...(volumeBroker
					? ([['NEHEMIAH_VOLUME_BROKER_SECRET', Redacted.value(volumeBroker.secret)]] as const)
					: []),
				...(telemetry
					? [
							[
								'NEHEMIAH_OTEL_AUTHORIZATION',
								Redacted.value(telemetry.authorization).slice(
									Redacted.value(telemetry.authorization).indexOf(' ') + 1
								)
							] as const
						]
					: [])
			];
			if (production) {
				const seenSecrets = new Set<string>();
				for (const [variable, value] of platformSecrets) {
					if (seenSecrets.has(value)) {
						throw new ConfigError({
							variable,
							message:
								'host encryption, gateway service, device-code lookup, telemetry, and volume capability secrets must be distinct'
						});
					}
					seenSecrets.add(value);
				}
			}
			if (production) {
				if (!env.CLERK_ISSUER) {
					throw new ConfigError({ variable: 'CLERK_ISSUER', message: 'is required in production' });
				}
				let issuer: URL;
				try {
					issuer = new URL(env.CLERK_ISSUER);
				} catch {
					throw new ConfigError({ variable: 'CLERK_ISSUER', message: 'must be an HTTPS URL' });
				}
				if (issuer.protocol !== 'https:' || issuer.username || issuer.password) {
					throw new ConfigError({ variable: 'CLERK_ISSUER', message: 'must be an HTTPS URL' });
				}
				if (!env.CLERK_AUDIENCE) {
					throw new ConfigError({
						variable: 'CLERK_AUDIENCE',
						message: 'is required in production'
					});
				}
			}
			const gatewayPublicUrl = env.NEHEMIAH_GATEWAY_URL ?? 'http://localhost:8082';
			let parsedGatewayUrl: URL;
			try {
				parsedGatewayUrl = new URL(gatewayPublicUrl);
			} catch {
				throw new ConfigError({
					variable: 'NEHEMIAH_GATEWAY_URL',
					message: 'must be an absolute URL'
				});
			}
			if (
				!['http:', 'https:'].includes(parsedGatewayUrl.protocol) ||
				parsedGatewayUrl.username ||
				parsedGatewayUrl.password ||
				parsedGatewayUrl.pathname !== '/' ||
				parsedGatewayUrl.search ||
				parsedGatewayUrl.hash ||
				(production && parsedGatewayUrl.protocol !== 'https:')
			) {
				throw new ConfigError({
					variable: 'NEHEMIAH_GATEWAY_URL',
					message: production
						? 'must be an origin-only HTTPS URL'
						: 'must be an origin-only HTTP(S) URL'
				});
			}
			const previewBaseDomain = env.NEHEMIAH_PREVIEW_BASE_DOMAIN?.toLowerCase();
			const trustedSiteDomain = env.NEHEMIAH_TRUSTED_SITE_DOMAIN?.toLowerCase();
			if (
				(production && !previewBaseDomain) ||
				(previewBaseDomain !== undefined &&
					(!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(previewBaseDomain) ||
						!previewBaseDomain.includes('.') ||
						previewBaseDomain.includes('..')))
			) {
				throw new ConfigError({
					variable: 'NEHEMIAH_PREVIEW_BASE_DOMAIN',
					message: 'must be a dedicated wildcard preview base domain'
				});
			}
			if (production && !trustedSiteDomain) {
				throw new ConfigError({
					variable: 'NEHEMIAH_TRUSTED_SITE_DOMAIN',
					message: 'is required to enforce preview site isolation'
				});
			}
			if (
				trustedSiteDomain &&
				(!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(trustedSiteDomain) ||
					!trustedSiteDomain.includes('.') ||
					trustedSiteDomain.includes('..'))
			) {
				throw new ConfigError({
					variable: 'NEHEMIAH_TRUSTED_SITE_DOMAIN',
					message: 'must be the registrable domain used by the dashboard and API'
				});
			}
			if (
				previewBaseDomain &&
				trustedSiteDomain &&
				(previewBaseDomain === trustedSiteDomain ||
					previewBaseDomain.endsWith(`.${trustedSiteDomain}`) ||
					trustedSiteDomain.endsWith(`.${previewBaseDomain}`) ||
					siteBoundarySuffix(previewBaseDomain) === siteBoundarySuffix(trustedSiteDomain))
			) {
				throw new ConfigError({
					variable: 'NEHEMIAH_PREVIEW_BASE_DOMAIN',
					message: 'must use a different registrable domain from the trusted dashboard/API site'
				});
			}
			const deviceVerificationValue =
				env.NEHEMIAH_DEVICE_VERIFICATION_URL ??
				(trustedSiteDomain
					? `https://${trustedSiteDomain}/dashboard/device`
					: 'http://localhost:5173/dashboard/device');
			let deviceVerificationUrl: URL;
			try {
				deviceVerificationUrl = new URL(deviceVerificationValue);
			} catch {
				throw new ConfigError({
					variable: 'NEHEMIAH_DEVICE_VERIFICATION_URL',
					message: 'must be an absolute HTTP(S) dashboard URL without query or fragment'
				});
			}
			if (
				!['http:', 'https:'].includes(deviceVerificationUrl.protocol) ||
				deviceVerificationUrl.username ||
				deviceVerificationUrl.password ||
				deviceVerificationUrl.search ||
				deviceVerificationUrl.hash ||
				(production && deviceVerificationUrl.protocol !== 'https:') ||
				(production &&
					trustedSiteDomain !== undefined &&
					deviceVerificationUrl.hostname !== trustedSiteDomain &&
					!deviceVerificationUrl.hostname.endsWith(`.${trustedSiteDomain}`))
			) {
				throw new ConfigError({
					variable: 'NEHEMIAH_DEVICE_VERIFICATION_URL',
					message: 'must be a query-free dashboard URL on the trusted HTTPS site'
				});
			}
			const hostCidrs = (
				env.NEHEMIAH_HOST_CIDRS ??
				(production
					? '10.64.0.0/16,fd00:6e65:6865::/64'
					: '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fd00::/8')
			)
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean);
			if (!hostCidrs.length) {
				throw new ConfigError({ variable: 'NEHEMIAH_HOST_CIDRS', message: 'must not be empty' });
			}
			return {
				environment,
				host: env.NEHEMIAH_HOST ?? '0.0.0.0',
				port: integer(env, 'PORT', 8081),
				databaseUrl,
				hostCredentialKey,
				gatewayToken,
				gatewaySecret,
				deviceCodePepper,
				gatewayPublicUrl: parsedGatewayUrl.origin,
				deviceVerificationUrl: deviceVerificationUrl.toString(),
				previewBaseDomain,
				trustedSiteDomain,
				hostCidrs,
				hostPort: integer(env, 'NEHEMIAH_HOST_PORT', 8080),
				clerkIssuer: env.CLERK_ISSUER,
				clerkAudience: env.CLERK_AUDIENCE,
				hostStaleAfterMs: integer(env, 'NEHEMIAH_HOST_STALE_MS', 30_000),
				defaultRegion,
				objectStorage,
				templateTransfers,
				volumeBroker,
				telemetry,
				apiRateLimit
			} satisfies ServiceConfig;
		},
		catch: (error) =>
			error instanceof ConfigError
				? error
				: new ConfigError({ variable: 'unknown', message: String(error) })
	});
