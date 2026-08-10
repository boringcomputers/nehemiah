import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../../src/http/openapi.js';
import { generateOpenApiModels } from '../../src/http/openapi-models.js';

interface Operation {
	readonly operationId: string;
	readonly deprecated?: boolean;
	readonly description?: string;
	readonly parameters?: ReadonlyArray<{
		readonly name?: string;
		readonly in?: string;
		readonly deprecated?: boolean;
		readonly description?: string;
	}>;
	readonly requestBody?: unknown;
	readonly responses: Readonly<Record<string, unknown>>;
	readonly security?: unknown;
	readonly 'x-nehemiah-websocket'?: {
		readonly required_subprotocol_prefix?: string;
		readonly query_credentials_allowed?: boolean;
		readonly client_frame_types?: ReadonlyArray<string>;
		readonly server_frame_types?: ReadonlyArray<string>;
		readonly max_client_frame_bytes?: number;
		readonly idle?: { readonly timeout_seconds?: number };
		readonly lifetime?: { readonly maximum_seconds?: number };
		readonly initial_client_frame?: {
			readonly required?: boolean;
			readonly deadline_seconds?: number;
			readonly goal_utf8_bytes?: { readonly maximum?: number };
		};
	};
}

interface PathItem {
	readonly parameters?: ReadonlyArray<{ readonly name?: string; readonly in?: string }>;
	readonly get?: Operation;
	readonly head?: Operation;
	readonly post?: Operation;
	readonly put?: Operation;
	readonly patch?: Operation;
	readonly delete?: Operation;
}

const methods = ['get', 'head', 'post', 'put', 'patch', 'delete'] as const;
const paths = openApiDocument.paths as unknown as Readonly<Record<string, PathItem>>;

const operations = (): Array<{ readonly key: string; readonly operation: Operation }> =>
	Object.entries(paths).flatMap(([path, item]) =>
		methods.flatMap((method) => {
			const operation = item[method];
			return operation ? [{ key: `${method.toUpperCase()} ${path}`, operation }] : [];
		})
	);

const expectedStatuses: Readonly<Record<string, ReadonlyArray<string>>> = {
	issueDeviceCode: ['201', '400', '413', '429', '500'],
	inspectDeviceAuthorization: ['200', '400', '401', '404', '409', '413', '429', '500', '503'],
	authorizeDevice: ['200', '400', '401', '403', '404', '409', '413', '429', '500', '503'],
	exchangeDeviceCode: ['200', '400', '413', '429', '500'],
	refreshDeviceCredential: ['200', '400', '413', '429', '500', '503'],
	revokeDeviceCredential: ['204', '400', '413', '500'],
	listOrganizations: ['200', '403', '429', '500', '503'],
	listProjects: ['200', '401', '429', '500', '503'],
	createProject: ['200', '201', '400', '403', '409', '413', '429', '500', '503'],
	listApiKeys: ['200', '403', '429', '500', '503'],
	createApiKey: ['201', '400', '403', '409', '413', '429', '500', '503'],
	revokeApiKey: ['204', '400', '403', '404', '429', '500', '503'],
	disableApiKey: ['204', '400', '403', '404', '429', '500', '503'],
	enableApiKey: ['204', '400', '403', '404', '429', '500', '503'],
	rotateApiKey: ['201', '400', '403', '404', '409', '429', '500', '503'],
	disableUserIdentity: ['200', '400', '401', '403', '404', '413', '429', '500', '503'],
	enableUserIdentity: ['200', '400', '401', '403', '404', '413', '429', '500', '503'],
	disableOrganizationIdentity: ['200', '400', '401', '403', '404', '413', '429', '500', '503'],
	enableOrganizationIdentity: ['200', '400', '401', '403', '404', '413', '429', '500', '503'],
	syncIdentityProviderLifecycle: [
		'200',
		'400',
		'401',
		'403',
		'404',
		'409',
		'413',
		'429',
		'500',
		'503'
	],
	listMachines: ['200', '401', '403', '429', '500', '503'],
	createMachine: [
		'200',
		'201',
		'202',
		'400',
		'401',
		'403',
		'409',
		'413',
		'429',
		'500',
		'501',
		'502',
		'503'
	],
	getMachine: ['200', '404', '429', '500', '503'],
	destroyMachine: ['204', '404', '429', '500', '503'],
	extendMachine: ['200', '400', '404', '409', '413', '429', '500', '501', '502', '503'],
	forkMachine: [
		'200',
		'201',
		'202',
		'400',
		'404',
		'409',
		'413',
		'422',
		'429',
		'500',
		'501',
		'502',
		'503'
	],
	execMachine: ['200', '400', '404', '409', '413', '429', '500', '503'],
	createMachineSession: ['200', '400', '404', '409', '413', '429', '500', '501', '503'],
	revokeMachineSession: ['204', '404', '429', '500', '503'],
	uploadMachineFile: ['200', '400', '401', '403', '404', '409', '413', '429', '502', '503'],
	downloadMachineFile: ['200', '400', '401', '403', '404', '409', '413', '429', '502', '503'],
	inspectMachineFile: ['200', '400', '401', '403', '404', '409', '413', '429', '502', '503'],
	connectMachineTty: ['101', '400', '401', '403', '404', '409', '413', '426', '429', '502', '503'],
	connectMachineVnc: ['101', '400', '401', '403', '404', '409', '413', '426', '429', '502', '503'],
	connectMachineDesktopAgent: [
		'101',
		'400',
		'401',
		'403',
		'404',
		'409',
		'413',
		'426',
		'429',
		'502',
		'503'
	],
	connectMachineShellAgent: [
		'101',
		'400',
		'401',
		'403',
		'404',
		'409',
		'413',
		'426',
		'429',
		'502',
		'503'
	],
	exchangePreviewCapability: ['204', '400', '401', '404', '413', '421', '429', '502', '503'],
	listManagedTemplates: ['200', '401', '403', '429', '500', '503'],
	publishManagedTemplate: [
		'201',
		'400',
		'401',
		'403',
		'404',
		'409',
		'413',
		'429',
		'500',
		'502',
		'503'
	],
	deleteManagedTemplate: ['204', '401', '403', '404', '409', '429', '500', '503'],
	listVolumes: ['200', '400', '401', '403', '429', '500', '503'],
	createVolume: [
		'200',
		'201',
		'400',
		'401',
		'403',
		'404',
		'409',
		'413',
		'429',
		'500',
		'502',
		'503'
	],
	getVolume: ['200', '404', '429', '500', '503'],
	deleteVolume: ['204', '404', '429', '500', '502', '503'],
	createVolumeGrant: ['200', '400', '401', '403', '404', '413', '429', '500', '502', '503'],
	downloadVolumeRevision: ['200', '400', '401', '404', '409', '502', '503'],
	uploadVolumeRevision: ['201', '204', '400', '401', '409', '413', '502', '503'],
	issueHostEnrollment: ['201', '400', '401', '403', '409', '413', '429', '500', '503'],
	revokeHostEnrollment: ['204', '400', '401', '403', '409', '429', '500', '503'],
	drainHost: ['200', '400', '401', '403', '409', '413', '429', '500', '503'],
	activateHost: ['200', '400', '401', '403', '409', '413', '429', '500', '503'],
	quarantineHost: ['200', '400', '401', '403', '409', '413', '429', '500', '503'],
	revokeHost: ['200', '400', '401', '403', '409', '413', '429', '500', '503'],
	rotateHostCredentials: ['200', '400', '401', '403', '409', '413', '429', '500', '503'],
	getBillingUsage: ['200', '401', '403', '429', '500', '503'],
	receiveStripeWebhook: ['200', '400', '413', '500', '503']
};

describe('public OpenAPI contract', () => {
	it('covers every registered public control-plane route and the HTTP capability routes', async () => {
		const routeDirectory = fileURLToPath(new URL('../../src/http/routes/', import.meta.url));
		const registered = new Set<string>();
		for (const file of await readdir(routeDirectory)) {
			if (!file.endsWith('.ts')) continue;
			const source = await readFile(
				new URL(`../../src/http/routes/${file}`, import.meta.url),
				'utf8'
			);
			for (const match of source.matchAll(/router\.(get|post|delete)\(\s*'([^']+)'/g)) {
				const path = match[2]!;
				if (!path.startsWith('/v1/')) continue;
				registered.add(
					`${match[1]!.toUpperCase()} ${path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}')}`
				);
			}
		}
		for (const capabilityRoute of [
			'POST /v1/capability/exchange',
			'GET /v1/volume-objects/{capabilityId}',
			'PUT /v1/volume-objects/{capabilityId}',
			'POST /v1/machines/{id}/upload',
			'GET /v1/machines/{id}/download',
			'HEAD /v1/machines/{id}/download',
			'GET /v1/machines/{id}/tty',
			'GET /v1/machines/{id}/vnc',
			'GET /v1/machines/{id}/agent',
			'GET /v1/machines/{id}/shell-agent'
		]) {
			registered.add(capabilityRoute);
		}
		for (const operation of ['drain', 'activate', 'quarantine', 'revoke']) {
			registered.add(`POST /v1/operator/hosts/{id}/${operation}`);
		}

		expect(new Set(operations().map(({ key }) => key))).toEqual(registered);
	});

	it('pins unique operation IDs and the implemented response status surface', () => {
		const documented = operations();
		expect(new Set(documented.map(({ operation }) => operation.operationId)).size).toBe(
			documented.length
		);
		expect(Object.keys(expectedStatuses).sort()).toEqual(
			documented.map(({ operation }) => operation.operationId).sort()
		);
		for (const { operation } of documented) {
			expect(Object.keys(operation.responses).sort()).toEqual(
				[...expectedStatuses[operation.operationId]!].sort()
			);
		}
	});

	it('documents Retry-After on every declared 429 response', () => {
		for (const { operation } of operations()) {
			const limited = operation.responses['429'] as
				| {
						readonly headers?: Readonly<
							Record<
								string,
								{ readonly schema?: { readonly minimum?: number; readonly maximum?: number } }
							>
						>;
				  }
				| undefined;
			if (limited) {
				expect(limited.headers?.['Retry-After']?.schema).toMatchObject({
					minimum: 1,
					maximum: 86_400
				});
			}
		}
	});

	it('bounds project listings to the database-enforced organization ceiling', () => {
		expect(openApiDocument.components.schemas.ProjectList.properties.projects.maxItems).toBe(64);
	});

	it('models gateway and proxied host failures on managed file routes', () => {
		for (const operation of [
			paths['/v1/machines/{id}/upload']!.post!,
			paths['/v1/machines/{id}/download']!.get!,
			paths['/v1/machines/{id}/download']!.head!
		]) {
			for (const status of ['502', '503']) {
				const response = operation.responses[status] as {
					readonly content?: Readonly<Record<string, { readonly schema?: unknown }>>;
					readonly headers?: Readonly<Record<string, unknown>>;
				};
				expect(response.content?.['application/problem+json']?.schema).toEqual({
					$ref: '#/components/schemas/Problem'
				});
				expect(response.content?.['application/json']?.schema).toEqual({
					$ref: '#/components/schemas/DataPlaneError'
				});
				if (status === '503') {
					expect(response.headers?.['Retry-After']).toMatchObject({
						schema: { minimum: 1, maximum: 86_400 }
					});
				}
			}
		}
	});

	it('documents retryable gateway unavailability for every public gateway operation', () => {
		for (const operation of [
			paths['/v1/machines/{id}/tty']!.get!,
			paths['/v1/machines/{id}/vnc']!.get!,
			paths['/v1/machines/{id}/agent']!.get!,
			paths['/v1/machines/{id}/shell-agent']!.get!,
			paths['/v1/capability/exchange']!.post!
		]) {
			const unavailable = operation.responses['503'] as {
				readonly headers?: Readonly<Record<string, unknown>>;
			};
			expect(unavailable.headers?.['Retry-After']).toMatchObject({
				schema: { minimum: 1, maximum: 86_400 }
			});
		}
	});

	it('resolves every component reference and bounds component object shapes', () => {
		const schemas = openApiDocument.components.schemas as unknown as Readonly<
			Record<string, { readonly type?: string; readonly additionalProperties?: unknown }>
		>;
		const serialized = JSON.stringify(openApiDocument);
		for (const match of serialized.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
			expect(schemas[match[1]!], `missing schema ${match[1]}`).toBeDefined();
		}
		for (const [name, schema] of Object.entries(schemas)) {
			if (schema.type === 'object') {
				expect(
					schema.additionalProperties,
					`${name} must choose an extension policy`
				).toBeDefined();
			}
		}
		expect(JSON.parse(serialized)).toEqual(openApiDocument);
	});

	it('keeps capabilities out of query parameters and marks managed OCI as typed unsupported', () => {
		for (const [path, item] of Object.entries(paths)) {
			const parameters = [
				...(item.parameters ?? []),
				...methods.flatMap((method) => item[method]?.parameters ?? [])
			];
			for (const parameter of parameters) {
				expect(
					parameter.in === 'query' && parameter.name?.toLowerCase().includes('token'),
					`${path} must not accept credentials in query parameters`
				).toBe(false);
			}
		}
		expect(paths['/v1/machines/{id}/upload']!.post!.security).toEqual([{ machineCapability: [] }]);
		expect(paths['/v1/machines/{id}/download']!.get!.security).toEqual([{ machineCapability: [] }]);
		const machineCreate = openApiDocument.components.schemas.CreateMachineRequest;
		expect(machineCreate.properties.oci_reference).toMatchObject({
			deprecated: true,
			description: expect.stringContaining('501 not_supported')
		});
		expect(paths['/v1/machines']!.post!.responses).toHaveProperty('501');
	});

	it('keeps device and refresh secrets out of every URL and marks unauthenticated exchanges', () => {
		for (const path of [
			'/v1/auth/device/code',
			'/v1/auth/device/token',
			'/v1/auth/device/refresh',
			'/v1/auth/device/revoke'
		]) {
			expect(paths[path]!.post!.security).toEqual([]);
			expect(paths[path]!.post!.parameters ?? []).toEqual([]);
		}
		const schemas = openApiDocument.components.schemas;
		expect(schemas.DeviceCodeResponse.properties.device_code).toMatchObject({ readOnly: true });
		expect(schemas.DeviceTokenResponse.properties.access_token).toMatchObject({ readOnly: true });
		expect(schemas.DeviceTokenResponse.properties.refresh_token).toMatchObject({ readOnly: true });
		expect(schemas.DeviceCodeResponse.properties.verification_uri_complete.description).toContain(
			'only the non-secret human user_code'
		);
	});

	it('keeps one-time response credentials in generated response schemas', () => {
		const schemas = openApiDocument.components.schemas;
		for (const [name, required, property] of [
			['token', schemas.MachineSession.required, schemas.MachineSession.properties.token],
			[
				'token',
				schemas.HostEnrollmentResponse.required,
				schemas.HostEnrollmentResponse.properties.token
			],
			[
				'credential',
				schemas.RotateHostCredentialsResponse.required,
				schemas.RotateHostCredentialsResponse.properties.credential
			]
		] as const) {
			expect(required).toContain(name);
			expect(property).toMatchObject({ readOnly: true });
			expect(property).not.toHaveProperty('writeOnly');
		}
	});

	it('documents the explicit bounded Clerk lifecycle sync contract', () => {
		const operation = paths['/v1/operator/identity-provider/sync']!.post!;
		expect(operation.operationId).toBe('syncIdentityProviderLifecycle');
		expect(operation.description).toContain('existing immutable local subjects');
		const schema = openApiDocument.components.schemas.IdentityProviderSyncRequest;
		expect(schema).toMatchObject({
			type: 'object',
			additionalProperties: false,
			required: expect.arrayContaining([
				'provider',
				'event_id',
				'source_version',
				'event_type',
				'clerk_user_id',
				'reason'
			])
		});
		expect(schema.properties.event_id.maxLength).toBe(128);
		expect(schema.properties.clerk_user_id.maxLength).toBe(256);
		expect(schema.properties.source_version.maximum).toBe(Number.MAX_SAFE_INTEGER);
		expect(schema.oneOf).toHaveLength(3);
	});

	it('advertises managed custom-template publication as production-disabled', () => {
		const publish = paths['/v1/templates']!.post!;
		expect(publish.deprecated).toBe(true);
		expect(publish.description).toContain('disabled in production');
		expect(publish.responses).toHaveProperty('503');
	});

	it('advertises every managed volume operation as production-disabled', () => {
		for (const operationId of [
			'listVolumes',
			'createVolume',
			'getVolume',
			'deleteVolume',
			'createVolumeGrant',
			'downloadVolumeRevision',
			'uploadVolumeRevision'
		]) {
			const operation = operations().find(
				(candidate) => candidate.operation.operationId === operationId
			)?.operation;
			expect(operation, operationId).toMatchObject({
				deprecated: true,
				description: expect.stringContaining('production-disabled')
			});
			expect(operation!.description, operationId).toContain('typed 503');
			expect(operation!.responses, operationId).toHaveProperty('503');
		}
	});

	it('bounds every managed WebSocket handshake without modeling protocol frames as JSON', () => {
		for (const path of [
			'/v1/machines/{id}/tty',
			'/v1/machines/{id}/vnc',
			'/v1/machines/{id}/agent',
			'/v1/machines/{id}/shell-agent'
		]) {
			const operation = paths[path]!.get!;
			const contract = operation['x-nehemiah-websocket']!;
			expect(operation.security).toEqual([{ websocketCapability: [] }]);
			expect(operation.responses).toHaveProperty('101');
			expect(contract.required_subprotocol_prefix).toBe('nehemiah.capability.');
			expect(contract.query_credentials_allowed).toBe(false);
			expect(contract.client_frame_types).not.toHaveLength(0);
			expect(contract.server_frame_types).not.toHaveLength(0);
			expect(contract.max_client_frame_bytes).toBeGreaterThan(0);
			expect(contract.max_client_frame_bytes).toBeLessThanOrEqual(1 << 20);
			expect(contract.idle?.timeout_seconds).toBe(90);
			expect(contract.lifetime?.maximum_seconds).toBeLessThanOrEqual(900);
		}

		const shell = paths['/v1/machines/{id}/shell-agent']!.get!;
		const desktop = paths['/v1/machines/{id}/agent']!.get!;
		for (const operation of [desktop, shell]) {
			expect(operation).toMatchObject({
				deprecated: true,
				description: expect.stringContaining('Local/self-hosted')
			});
			const start = operation['x-nehemiah-websocket']!.initial_client_frame!;
			expect(start).toMatchObject({ required: true, deadline_seconds: 5 });
			expect(start.goal_utf8_bytes?.maximum).toBe(4_096);
		}
		expect(desktop.parameters?.find((parameter) => parameter.name === 'goal')).toBeUndefined();
		expect(shell.parameters?.find((parameter) => parameter.name === 'goal')).toMatchObject({
			in: 'query',
			deprecated: true,
			description: expect.stringContaining('Legacy local/self-hosted')
		});
	});
});

describe('generated wire models', () => {
	it('are deterministic, marked generated, bounded in size, and checked into the tree', async () => {
		const first = generateOpenApiModels(openApiDocument);
		const second = generateOpenApiModels(openApiDocument);
		expect(second).toEqual(first);
		for (const file of first) {
			const absolute = new URL(`../../../../${file.path}`, import.meta.url);
			const checkedIn = await readFile(absolute, 'utf8');
			const withoutFormatting = (value: string): string => value.replaceAll(/\s+/g, '');
			expect(
				file.path.endsWith('/go/models.go') ? withoutFormatting(checkedIn) : checkedIn,
				file.path
			).toBe(
				file.path.endsWith('/go/models.go') ? withoutFormatting(file.contents) : file.contents
			);
			expect(checkedIn).toContain('Code generated from Nehemiah OpenAPI');
			expect(Buffer.byteLength(checkedIn)).toBeLessThan(512 << 10);
		}
	});
});
