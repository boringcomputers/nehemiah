import { json } from './router.js';
const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
const jsonResponse = (description, schema) => ({
    description,
    content: { 'application/json': { schema: schemaRef(schema) } }
});
const problemResponse = (description) => ({
    description,
    content: { 'application/problem+json': { schema: schemaRef('Problem') } }
});
const retryAfterHeaders = {
    'Retry-After': {
        description: 'Whole seconds the client should wait before retrying this admission.',
        schema: { type: 'integer', minimum: 1, maximum: 86_400 }
    }
};
const rateLimitResponse = {
    ...problemResponse('Rate or quota limit reached'),
    headers: retryAfterHeaders
};
const dataPlaneErrorResponse = (description) => ({
    description,
    content: {
        'application/problem+json': { schema: schemaRef('Problem') },
        'application/json': { schema: schemaRef('DataPlaneError') }
    }
});
const websocketErrorResponse = (description) => ({
    description,
    content: {
        'application/problem+json': { schema: schemaRef('Problem') },
        'application/json': { schema: schemaRef('DataPlaneError') },
        'text/plain': { schema: { type: 'string', maxLength: 4_096 } }
    }
});
const errorDescriptions = {
    400: 'Invalid request',
    401: 'Authentication required',
    403: 'Permission denied',
    404: 'Resource not found',
    409: 'Request conflicts with current state',
    413: 'Request body too large',
    421: 'Capability belongs to another isolated origin',
    422: 'Request cannot be processed for this resource',
    426: 'WebSocket upgrade required',
    429: 'Rate or quota limit reached',
    500: 'Internal operation failure',
    501: 'Operation is not supported',
    502: 'Upstream host or storage failure',
    503: 'Required capacity or infrastructure unavailable'
};
const errors = (...statuses) => Object.fromEntries(statuses.map((status) => [
    String(status),
    status === 429 ? rateLimitResponse : problemResponse(errorDescriptions[status])
]));
const websocketErrors = (...statuses) => Object.fromEntries(statuses.map((status) => [
    String(status),
    status === 429 || status === 503
        ? {
            ...websocketErrorResponse(errorDescriptions[status]),
            headers: retryAfterHeaders
        }
        : websocketErrorResponse(errorDescriptions[status])
]));
const gatewayErrors = (...statuses) => Object.fromEntries(statuses.map((status) => [
    String(status),
    status === 429
        ? rateLimitResponse
        : status === 503
            ? { ...problemResponse(errorDescriptions[status]), headers: retryAfterHeaders }
            : problemResponse(errorDescriptions[status])
]));
const proxiedDataPlaneErrors = (...statuses) => Object.fromEntries(statuses.map((status) => [
    String(status),
    status === 503
        ? { ...dataPlaneErrorResponse(errorDescriptions[status]), headers: retryAfterHeaders }
        : dataPlaneErrorResponse(errorDescriptions[status])
]));
const jsonRequest = (schema) => ({
    required: true,
    content: { 'application/json': { schema: schemaRef(schema) } }
});
const pathId = (pattern = '^[A-Za-z0-9_-]{1,128}$') => ({
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', pattern }
});
const projectQuery = {
    name: 'project_id',
    in: 'query',
    required: false,
    schema: { type: 'string', format: 'uuid' }
};
const managedVolumeDisabledDescription = 'Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.';
const idempotencyKey = {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' }
};
const websocketUpgradeParameters = [
    {
        name: 'Connection',
        in: 'header',
        required: true,
        description: 'Must include the Upgrade token.',
        schema: { type: 'string', maxLength: 256 }
    },
    {
        name: 'Upgrade',
        in: 'header',
        required: true,
        schema: { type: 'string', const: 'websocket' }
    }
];
const websocketSwitchingProtocols = {
    description: 'WebSocket connection established; subsequent messages are protocol-specific frames.',
    headers: {
        Connection: { schema: { type: 'string', const: 'Upgrade' } },
        Upgrade: { schema: { type: 'string', const: 'websocket' } }
    }
};
const websocketContract = ({ capability, clientFrames, serverFrames, maxClientFrameBytes, maxLifetimeSeconds = 900, initialFrame }) => ({
    capability,
    required_subprotocol_prefix: 'nehemiah.capability.',
    query_credentials_allowed: false,
    client_frame_types: clientFrames,
    server_frame_types: serverFrames,
    max_client_frame_bytes: maxClientFrameBytes,
    idle: {
        timeout_seconds: 90,
        behavior: 'Gateway/host pings require a timely pong; protocol activity refreshes applicable reads.'
    },
    lifetime: {
        maximum_seconds: maxLifetimeSeconds,
        behavior: 'Closes at the earliest of capability expiry, current machine-lease expiry, gateway stream limit, or this protocol limit.'
    },
    ...(initialFrame === undefined ? {} : { initial_client_frame: initialFrame }),
    payload_modeling: 'Message payloads are protocol-specific frames and are not JSON request/response bodies modeled by OpenAPI.'
});
export const openApiDocument = {
    openapi: '3.1.0',
    info: {
        title: 'Nehemiah API',
        version: '1.0.0-beta.1',
        description: 'Public Boring Computers control-plane and capability-gateway HTTP contract. WebSocket byte channels are documented separately.'
    },
    servers: [{ url: 'https://api.boringcomputers.com' }],
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'bc_... or dashboard session'
            },
            machineCapability: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'short-lived machine capability'
            },
            websocketCapability: {
                type: 'apiKey',
                in: 'header',
                name: 'Sec-WebSocket-Protocol',
                description: 'Short-lived machine capability prefixed with nehemiah.capability.; credentials in the URL are forbidden.'
            },
            volumeCapability: {
                type: 'apiKey',
                in: 'header',
                name: 'x-nehemiah-volume-capability'
            }
        },
        schemas: {
            Problem: {
                type: 'object',
                required: ['type', 'title', 'status', 'detail'],
                properties: {
                    type: { type: 'string', format: 'uri' },
                    title: { type: 'string' },
                    status: { type: 'integer', minimum: 400, maximum: 599 },
                    detail: { type: 'string' },
                    request_id: { type: 'string', maxLength: 128 },
                    operation_may_have_completed: { type: 'boolean' }
                },
                additionalProperties: true
            },
            DataPlaneError: {
                type: 'object',
                required: ['error'],
                properties: {
                    error: { type: 'string', minLength: 1, maxLength: 4_096 },
                    feature: { type: 'string', maxLength: 128 }
                },
                additionalProperties: false
            },
            Organization: {
                type: 'object',
                required: ['id', 'slug', 'name'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    slug: { type: 'string' },
                    name: { type: 'string' }
                },
                additionalProperties: false
            },
            OrganizationList: {
                type: 'object',
                required: ['organizations'],
                properties: {
                    organizations: { type: 'array', items: schemaRef('Organization') }
                },
                additionalProperties: false
            },
            Project: {
                type: 'object',
                required: [
                    'id',
                    'organization_id',
                    'slug',
                    'name',
                    'max_machines',
                    'max_vcpus',
                    'max_memory_mb',
                    'max_disk_mb',
                    'max_storage_mb'
                ],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    organization_id: { type: 'string', format: 'uuid' },
                    slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
                    name: { type: 'string', minLength: 1, maxLength: 160 },
                    max_machines: { type: 'integer', minimum: 0 },
                    max_vcpus: { type: 'integer', minimum: 0 },
                    max_memory_mb: { type: 'integer', minimum: 0 },
                    max_disk_mb: {
                        type: 'integer',
                        minimum: 0,
                        maximum: Number.MAX_SAFE_INTEGER,
                        description: 'Maximum active machine disk reservation in MiB.'
                    },
                    max_storage_mb: {
                        type: 'integer',
                        minimum: 0,
                        maximum: Number.MAX_SAFE_INTEGER,
                        description: 'Maximum durable managed-volume allocation in MiB.'
                    }
                },
                additionalProperties: false
            },
            ProjectList: {
                type: 'object',
                required: ['projects'],
                properties: {
                    projects: { type: 'array', maxItems: 64, items: schemaRef('Project') }
                },
                additionalProperties: false
            },
            CreateProjectRequest: {
                type: 'object',
                required: ['slug', 'name'],
                properties: {
                    slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
                    name: { type: 'string', minLength: 1, maxLength: 160 }
                },
                additionalProperties: false
            },
            ApiKeyScope: {
                type: 'string',
                enum: [
                    'machines:read',
                    'machines:write',
                    'templates:read',
                    'templates:write',
                    'volumes:read',
                    'volumes:write',
                    'billing:read'
                ]
            },
            ApiKey: {
                type: 'object',
                required: ['id', 'name', 'prefix', 'scopes'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    project_id: { type: 'string', format: 'uuid' },
                    name: { type: 'string', minLength: 1, maxLength: 160 },
                    prefix: { type: 'string', pattern: '^bc_(?:live|test)_[a-f0-9]{12}$' },
                    scopes: { type: 'array', minItems: 1, items: schemaRef('ApiKeyScope') },
                    created_at: { type: 'string', format: 'date-time' },
                    last_used_at: { type: 'string', format: 'date-time' },
                    expires_at: { type: 'string', format: 'date-time' },
                    disabled_at: { type: 'string', format: 'date-time' },
                    revoked_at: { type: 'string', format: 'date-time' }
                },
                additionalProperties: false
            },
            ApiKeyList: {
                type: 'object',
                required: ['api_keys'],
                properties: { api_keys: { type: 'array', items: schemaRef('ApiKey') } },
                additionalProperties: false
            },
            CreateApiKeyRequest: {
                type: 'object',
                required: ['name', 'scopes'],
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 160 },
                    project_id: { type: 'string', format: 'uuid' },
                    scopes: { type: 'array', minItems: 1, items: schemaRef('ApiKeyScope') },
                    expires_at: { type: 'string', format: 'date-time' }
                },
                additionalProperties: false
            },
            CreateApiKeyResponse: {
                type: 'object',
                required: ['id', 'key', 'prefix', 'secret_displayed_once'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    key: { type: 'string', pattern: '^bc_(?:live|test)_[a-f0-9]{12}_[A-Za-z0-9_-]{32,}$' },
                    prefix: { type: 'string', pattern: '^bc_(?:live|test)_[a-f0-9]{12}$' },
                    secret_displayed_once: { type: 'boolean', const: true }
                },
                additionalProperties: false
            },
            RotateApiKeyResponse: {
                type: 'object',
                required: ['id', 'key', 'prefix', 'rotated_from_id', 'secret_displayed_once'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    key: {
                        type: 'string',
                        pattern: '^bc_(?:live|test)_[a-f0-9]{12}_[A-Za-z0-9_-]{32,}$',
                        readOnly: true
                    },
                    prefix: { type: 'string', pattern: '^bc_(?:live|test)_[a-f0-9]{12}$' },
                    rotated_from_id: { type: 'string', format: 'uuid' },
                    secret_displayed_once: { type: 'boolean', const: true }
                },
                additionalProperties: false
            },
            IdentityLifecycleRequest: {
                type: 'object',
                required: ['reason'],
                properties: { reason: { type: 'string', minLength: 1, maxLength: 512 } },
                additionalProperties: false
            },
            IdentityLifecycleState: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    disabled_at: { type: 'string', format: 'date-time' }
                },
                additionalProperties: false
            },
            UserIdentityLifecycleResponse: {
                type: 'object',
                required: ['user', 'changed'],
                properties: {
                    user: schemaRef('IdentityLifecycleState'),
                    changed: { type: 'boolean' }
                },
                additionalProperties: false
            },
            OrganizationIdentityLifecycleResponse: {
                type: 'object',
                required: ['organization', 'changed'],
                properties: {
                    organization: schemaRef('IdentityLifecycleState'),
                    changed: { type: 'boolean' }
                },
                additionalProperties: false
            },
            IdentityProviderSyncEventType: {
                type: 'string',
                enum: ['user.disabled', 'user.deleted', 'membership.upserted', 'membership.removed']
            },
            IdentityProviderMembershipRole: {
                type: 'string',
                enum: ['owner', 'admin', 'member', 'billing']
            },
            IdentityProviderSyncRequest: {
                type: 'object',
                description: 'A bounded, source-ordered Clerk lifecycle event. User events forbid organization_id/role; membership.upserted requires both; membership.removed requires organization_id and forbids role.',
                required: [
                    'provider',
                    'event_id',
                    'source_version',
                    'event_type',
                    'clerk_user_id',
                    'reason'
                ],
                oneOf: [
                    {
                        properties: {
                            event_type: { enum: ['user.disabled', 'user.deleted'] }
                        },
                        not: { anyOf: [{ required: ['organization_id'] }, { required: ['role'] }] }
                    },
                    {
                        properties: { event_type: { const: 'membership.upserted' } },
                        required: ['organization_id', 'role']
                    },
                    {
                        properties: { event_type: { const: 'membership.removed' } },
                        required: ['organization_id'],
                        not: { required: ['role'] }
                    }
                ],
                properties: {
                    provider: { type: 'string', const: 'clerk' },
                    event_id: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128,
                        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
                    },
                    source_version: {
                        type: 'integer',
                        minimum: 1,
                        maximum: Number.MAX_SAFE_INTEGER
                    },
                    event_type: schemaRef('IdentityProviderSyncEventType'),
                    clerk_user_id: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 256,
                        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
                    },
                    organization_id: { type: 'string', format: 'uuid' },
                    role: schemaRef('IdentityProviderMembershipRole'),
                    reason: { type: 'string', minLength: 1, maxLength: 512 }
                },
                additionalProperties: false
            },
            IdentityProviderSyncResponse: {
                type: 'object',
                required: ['provider', 'event_id', 'source_version', 'result', 'changed', 'user_id'],
                properties: {
                    provider: { type: 'string', const: 'clerk' },
                    event_id: {
                        type: 'string',
                        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
                    },
                    source_version: {
                        type: 'integer',
                        minimum: 1,
                        maximum: Number.MAX_SAFE_INTEGER
                    },
                    result: { type: 'string', enum: ['applied', 'stale', 'replayed'] },
                    changed: { type: 'boolean' },
                    user_id: { type: 'string', format: 'uuid' },
                    organization_id: { type: 'string', format: 'uuid' }
                },
                additionalProperties: false
            },
            DeviceCodeRequest: {
                type: 'object',
                required: ['client_id', 'scopes'],
                properties: {
                    client_id: { type: 'string', const: 'nehemiah-cli' },
                    scopes: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 7,
                        uniqueItems: true,
                        items: schemaRef('ApiKeyScope')
                    }
                },
                additionalProperties: false
            },
            DeviceCodeResponse: {
                type: 'object',
                required: [
                    'device_code',
                    'user_code',
                    'verification_uri',
                    'verification_uri_complete',
                    'expires_in',
                    'interval',
                    'scopes'
                ],
                properties: {
                    device_code: {
                        type: 'string',
                        pattern: '^bc_device_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$',
                        readOnly: true
                    },
                    user_code: { type: 'string', pattern: '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$' },
                    verification_uri: { type: 'string', format: 'uri' },
                    verification_uri_complete: {
                        type: 'string',
                        format: 'uri',
                        description: 'Contains only the non-secret human user_code query parameter.'
                    },
                    expires_in: { type: 'integer', minimum: 60, maximum: 600 },
                    interval: { type: 'integer', minimum: 5, maximum: 60 },
                    scopes: { type: 'array', minItems: 1, items: schemaRef('ApiKeyScope') }
                },
                additionalProperties: false
            },
            InspectDeviceCodeRequest: {
                type: 'object',
                required: ['user_code'],
                properties: {
                    user_code: { type: 'string', pattern: '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$' }
                },
                additionalProperties: false
            },
            DeviceAuthorizationRequest: {
                type: 'object',
                required: ['client_id', 'scopes', 'expires_at', 'status'],
                properties: {
                    client_id: { type: 'string', const: 'nehemiah-cli' },
                    scopes: { type: 'array', minItems: 1, items: schemaRef('ApiKeyScope') },
                    expires_at: { type: 'string', format: 'date-time' },
                    status: { type: 'string', const: 'pending' }
                },
                additionalProperties: false
            },
            AuthorizeDeviceRequest: {
                type: 'object',
                required: ['user_code', 'decision'],
                properties: {
                    user_code: { type: 'string', pattern: '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$' },
                    decision: { type: 'string', enum: ['approve', 'deny'] },
                    project_id: { type: 'string', format: 'uuid' },
                    scopes: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 7,
                        uniqueItems: true,
                        items: schemaRef('ApiKeyScope')
                    }
                },
                additionalProperties: false
            },
            DeviceAuthorizationDecision: {
                type: 'object',
                required: ['decision', 'authorized', 'denied'],
                properties: {
                    decision: { type: 'string', enum: ['approve', 'deny'] },
                    authorized: { type: 'boolean' },
                    denied: { type: 'boolean' }
                },
                additionalProperties: false
            },
            ExchangeDeviceCodeRequest: {
                type: 'object',
                required: ['device_code'],
                properties: {
                    device_code: {
                        type: 'string',
                        pattern: '^bc_device_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$',
                        writeOnly: true
                    }
                },
                additionalProperties: false
            },
            RefreshDeviceTokenRequest: {
                type: 'object',
                required: ['refresh_token'],
                properties: {
                    refresh_token: {
                        type: 'string',
                        pattern: '^bc_refresh_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$',
                        writeOnly: true
                    }
                },
                additionalProperties: false
            },
            DeviceTokenResponse: {
                type: 'object',
                required: [
                    'token_type',
                    'access_token',
                    'expires_in',
                    'refresh_token',
                    'refresh_expires_in',
                    'organization_id',
                    'project_id',
                    'scopes'
                ],
                properties: {
                    token_type: { type: 'string', const: 'Bearer' },
                    access_token: {
                        type: 'string',
                        pattern: '^bc_access_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$',
                        readOnly: true
                    },
                    expires_in: { type: 'integer', minimum: 1, maximum: 900 },
                    refresh_token: {
                        type: 'string',
                        pattern: '^bc_refresh_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$',
                        readOnly: true
                    },
                    refresh_expires_in: { type: 'integer', minimum: 1, maximum: 2_592_000 },
                    organization_id: { type: 'string', format: 'uuid' },
                    project_id: { type: 'string', format: 'uuid' },
                    scopes: { type: 'array', minItems: 1, items: schemaRef('ApiKeyScope') }
                },
                additionalProperties: false
            },
            MachineState: {
                type: 'string',
                enum: [
                    'requested',
                    'placing',
                    'starting',
                    'running',
                    'stopping',
                    'stopped',
                    'failed',
                    'lost'
                ]
            },
            Architecture: { type: 'string', enum: ['x86_64', 'aarch64'] },
            RuntimeCohort: {
                type: 'object',
                required: [
                    'id',
                    'contract_version',
                    'arch',
                    'kernel_sha256',
                    'firecracker_sha256',
                    'jailer_sha256',
                    'python_rootfs_sha256',
                    'desktop_rootfs_sha256'
                ],
                properties: {
                    id: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    contract_version: { type: 'integer', const: 4 },
                    arch: { type: 'string', enum: ['amd64', 'arm64'] },
                    kernel_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    firecracker_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    jailer_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    python_rootfs_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    desktop_rootfs_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }
                },
                additionalProperties: false,
                description: 'Exact signed managed-host runtime cohort. id is SHA-256 of the canonical contract-version, architecture, built-in rootfs, kernel, Firecracker, and jailer digest lines.'
            },
            MachineResources: {
                type: 'object',
                required: ['vcpus', 'memory_mb', 'disk_mb'],
                properties: {
                    vcpus: { type: 'integer', minimum: 1, maximum: 4 },
                    memory_mb: { type: 'integer', minimum: 1, maximum: 4_096 },
                    disk_mb: { type: 'integer', minimum: 1, maximum: 20_480 }
                },
                additionalProperties: false
            },
            NetworkPolicy: {
                type: 'object',
                required: ['mode', 'hostnames', 'cidrs'],
                properties: {
                    mode: { type: 'string', enum: ['off', 'allowlist'] },
                    hostnames: { type: 'array', maxItems: 64, items: { type: 'string' } },
                    cidrs: { type: 'array', maxItems: 64, items: { type: 'string' } }
                },
                additionalProperties: false
            },
            NetworkPolicyDeclaration: {
                type: 'object',
                required: ['mode'],
                description: 'Managed beta is fail-closed to mode=off until aggregate organization, project, and host-network traffic quotas exist.',
                properties: {
                    mode: { type: 'string', enum: ['off'] },
                    hostnames: { type: 'array', maxItems: 0, items: { type: 'string' } },
                    cidrs: { type: 'array', maxItems: 0, items: { type: 'string' } }
                },
                additionalProperties: false
            },
            Machine: {
                type: 'object',
                required: [
                    'id',
                    'project_id',
                    'state',
                    'status',
                    'ready',
                    'region',
                    'architecture',
                    'resources',
                    'network_policy',
                    'created_at',
                    'expires_at'
                ],
                properties: {
                    id: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' },
                    project_id: { type: 'string', format: 'uuid' },
                    state: schemaRef('MachineState'),
                    status: schemaRef('MachineState'),
                    ready: { type: 'boolean' },
                    region: { type: 'string' },
                    architecture: schemaRef('Architecture'),
                    runtime_cohort_id: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    source_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    resources: schemaRef('MachineResources'),
                    template: { type: 'string' },
                    template_id: { type: 'string', format: 'uuid' },
                    oci_reference: { type: 'string' },
                    network_policy: schemaRef('NetworkPolicy'),
                    parent_id: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' },
                    created_at: { type: 'string', format: 'date-time' },
                    started_at: { type: 'string', format: 'date-time' },
                    ready_at: { type: 'string', format: 'date-time' },
                    stopped_at: { type: 'string', format: 'date-time' },
                    expires_at: { type: 'string', format: 'date-time' },
                    failure_reason: { type: 'string' }
                },
                additionalProperties: false
            },
            MachineList: {
                type: 'object',
                required: ['machines'],
                properties: {
                    machines: { type: 'array', items: schemaRef('Machine') },
                    next_cursor: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' }
                },
                additionalProperties: false
            },
            CreateMachineRequest: {
                type: 'object',
                oneOf: [
                    { required: ['template'] },
                    { required: ['template_id'] },
                    { required: ['oci_reference'] }
                ],
                properties: {
                    project_id: { type: 'string', format: 'uuid' },
                    region: { type: 'string' },
                    architecture: schemaRef('Architecture'),
                    template: { type: 'string', enum: ['python', 'desktop'] },
                    template_id: { type: 'string', format: 'uuid' },
                    oci_reference: {
                        type: 'string',
                        deprecated: true,
                        description: 'Reserved field. Managed OCI imports return typed 501 not_supported.'
                    },
                    ttl_seconds: { type: 'integer', minimum: 15, maximum: 86_400 },
                    vcpus: { type: 'integer', minimum: 1, maximum: 4 },
                    memory_mb: { type: 'integer', minimum: 1, maximum: 4_096 },
                    disk_mb: { type: 'integer', minimum: 1, maximum: 20_480 },
                    network_policy: schemaRef('NetworkPolicyDeclaration')
                },
                additionalProperties: false
            },
            ExtendMachineRequest: {
                type: 'object',
                properties: { ttl_seconds: { type: 'integer', minimum: 15, maximum: 86_400 } },
                additionalProperties: false
            },
            ForkMachineRequest: {
                type: 'object',
                properties: { count: { type: 'integer', minimum: 1, maximum: 8, default: 1 } },
                additionalProperties: false
            },
            MachineBatch: {
                type: 'object',
                required: ['machines', 'requested'],
                properties: {
                    machines: { type: 'array', items: schemaRef('Machine') },
                    requested: { type: 'integer', minimum: 2, maximum: 8 }
                },
                additionalProperties: false
            },
            PendingForkOperation: {
                type: 'object',
                required: ['id', 'state', 'idempotency_key', 'source_machine_id', 'requested'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    state: { type: 'string', enum: ['pending', 'cleanup_pending'] },
                    idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
                    source_machine_id: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' },
                    requested: { type: 'integer', minimum: 1, maximum: 8 }
                },
                additionalProperties: false
            },
            PendingForkResponse: {
                type: 'object',
                required: ['operation', 'machines', 'requested'],
                properties: {
                    operation: schemaRef('PendingForkOperation'),
                    machines: { type: 'array', items: schemaRef('Machine') },
                    requested: { type: 'integer', minimum: 1, maximum: 8 }
                },
                additionalProperties: false
            },
            ExecMachineRequest: {
                type: 'object',
                required: ['command'],
                properties: {
                    command: { type: 'string', minLength: 1, maxLength: 65_536 },
                    timeout_seconds: { type: 'integer', minimum: 1, maximum: 120, default: 30 }
                },
                additionalProperties: false
            },
            ExecResult: {
                type: 'object',
                required: ['exit_code', 'timed_out', 'duration_ms'],
                properties: {
                    output: { type: 'string' },
                    stdout: { type: 'string' },
                    stderr: { type: 'string' },
                    exit_code: { type: ['integer', 'null'] },
                    timed_out: { type: 'boolean' },
                    duration_ms: { type: 'integer', minimum: 0 }
                },
                additionalProperties: false
            },
            GatewayCapability: {
                type: 'string',
                enum: ['tty', 'vnc', 'agent', 'files', 'preview'],
                description: 'Gateway capability. The agent value is reserved for local/self-hosted compatibility and receives typed 501 not_supported from managed session issuance.'
            },
            CreateMachineSessionRequest: {
                type: 'object',
                properties: {
                    capabilities: {
                        type: 'array',
                        minItems: 1,
                        uniqueItems: true,
                        items: schemaRef('GatewayCapability')
                    },
                    port: { type: 'integer', minimum: 1, maximum: 65_535 },
                    ttl_seconds: { type: 'integer', minimum: 1, maximum: 900, default: 300 }
                },
                additionalProperties: false
            },
            MachineSession: {
                type: 'object',
                required: ['id', 'token', 'expires_in', 'gateway_url'],
                properties: {
                    id: { type: 'string', format: 'uuid', readOnly: true },
                    token: { type: 'string', minLength: 1, maxLength: 4096, readOnly: true },
                    expires_in: { type: 'integer', minimum: 1, maximum: 900 },
                    gateway_url: { type: 'string', format: 'uri' },
                    preview_url: { type: 'string', format: 'uri' }
                },
                additionalProperties: false
            },
            FileUploadResult: {
                type: 'object',
                required: ['ok', 'path', 'bytes', 'transport'],
                properties: {
                    ok: { type: 'boolean', const: true },
                    path: { type: 'string', pattern: '^/root/[A-Za-z0-9._-]+$' },
                    bytes: { type: 'integer', minimum: 0, maximum: 16_777_216 },
                    transport: { type: 'string', const: 'vsock' }
                },
                additionalProperties: false
            },
            TemplateSource: {
                type: 'object',
                required: ['machine_id'],
                properties: {
                    machine_id: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' }
                },
                additionalProperties: false
            },
            TemplateArtifact: {
                type: 'object',
                required: ['object_key', 'checksum', 'size_bytes'],
                properties: {
                    object_key: { type: 'string' },
                    checksum: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                    size_bytes: { type: 'integer', minimum: 1, maximum: 5_368_709_120 }
                },
                additionalProperties: false
            },
            ManagedTemplateManifest: {
                type: 'object',
                required: ['schema_version', 'format', 'architecture', 'source', 'artifact'],
                properties: {
                    schema_version: { type: 'integer', const: 1 },
                    format: { type: 'string', const: 'firecracker-snapshot-v1' },
                    architecture: schemaRef('Architecture'),
                    source: schemaRef('TemplateSource'),
                    artifact: schemaRef('TemplateArtifact')
                },
                additionalProperties: false
            },
            ManagedTemplate: {
                type: 'object',
                required: [
                    'id',
                    'project_id',
                    'name',
                    'version',
                    'manifest',
                    'checksum',
                    'size_bytes',
                    'source_machine_id',
                    'created_at'
                ],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    project_id: { type: 'string', format: 'uuid' },
                    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' },
                    version: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$' },
                    manifest: schemaRef('ManagedTemplateManifest'),
                    checksum: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                    size_bytes: { type: 'integer', minimum: 1, maximum: 5_368_709_120 },
                    source_machine_id: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' },
                    created_at: { type: 'string', format: 'date-time' }
                },
                additionalProperties: false
            },
            ManagedTemplateList: {
                type: 'object',
                required: ['templates'],
                properties: { templates: { type: 'array', items: schemaRef('ManagedTemplate') } },
                additionalProperties: false
            },
            PublishTemplateRequest: {
                type: 'object',
                required: ['machine_id', 'name', 'version'],
                properties: {
                    project_id: { type: 'string', format: 'uuid' },
                    machine_id: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' },
                    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' },
                    version: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$' }
                },
                additionalProperties: false
            },
            Volume: {
                type: 'object',
                required: ['id', 'project_id', 'created_at', 'expires_at', 'quota_mb', 'used_bytes'],
                properties: {
                    id: { type: 'string', pattern: '^vol_[A-Za-z0-9_-]{22}$' },
                    project_id: { type: 'string', format: 'uuid' },
                    created_at: { type: 'string', format: 'date-time' },
                    expires_at: { type: 'string', format: 'date-time' },
                    quota_mb: { type: 'integer', minimum: 1, maximum: 1_048_576 },
                    used_bytes: { type: 'integer', minimum: 0, maximum: 1_099_511_627_776 },
                    deleted_at: { type: 'string', format: 'date-time' },
                    delete_after: { type: 'string', format: 'date-time' }
                },
                additionalProperties: false
            },
            VolumeGrant: {
                type: 'object',
                required: ['method', 'url', 'headers', 'expires_at'],
                properties: {
                    method: { type: 'string', enum: ['GET', 'PUT'] },
                    url: { type: 'string', format: 'uri-reference' },
                    headers: {
                        type: 'object',
                        additionalProperties: { type: 'string' },
                        maxProperties: 16
                    },
                    expires_at: { type: 'string', format: 'date-time' },
                    maximum_bytes: { type: 'integer', minimum: 1, maximum: 1_099_511_627_776 }
                },
                additionalProperties: false
            },
            VolumeWithGrant: {
                type: 'object',
                required: [
                    'id',
                    'project_id',
                    'created_at',
                    'expires_at',
                    'quota_mb',
                    'used_bytes',
                    'grant'
                ],
                properties: {
                    id: { type: 'string', pattern: '^vol_[A-Za-z0-9_-]{22}$' },
                    project_id: { type: 'string', format: 'uuid' },
                    created_at: { type: 'string', format: 'date-time' },
                    expires_at: { type: 'string', format: 'date-time' },
                    quota_mb: { type: 'integer', minimum: 1, maximum: 1_048_576 },
                    used_bytes: { type: 'integer', minimum: 0, maximum: 1_099_511_627_776 },
                    grant: schemaRef('VolumeGrant')
                },
                additionalProperties: false
            },
            VolumeList: {
                type: 'object',
                required: ['volumes'],
                properties: { volumes: { type: 'array', items: schemaRef('Volume') } },
                additionalProperties: false
            },
            CreateVolumeRequest: {
                type: 'object',
                properties: {
                    project_id: { type: 'string', format: 'uuid' },
                    size_limit_mb: { type: 'integer', minimum: 1, maximum: 1_048_576 },
                    ttl_seconds: { type: 'integer', minimum: 3_600, maximum: 31_536_000 },
                    grant_ttl_seconds: { type: 'integer', minimum: 1, maximum: 900 }
                },
                additionalProperties: false
            },
            CreateVolumeGrantRequest: {
                type: 'object',
                required: ['method'],
                properties: {
                    method: { type: 'string', enum: ['GET', 'PUT'] },
                    ttl_seconds: { type: 'integer', minimum: 1, maximum: 900 }
                },
                additionalProperties: false
            },
            VolumeGrantResponse: {
                type: 'object',
                required: ['volume', 'grant'],
                properties: { volume: schemaRef('Volume'), grant: schemaRef('VolumeGrant') },
                additionalProperties: false
            },
            CreateHostEnrollmentRequest: {
                type: 'object',
                required: [
                    'provider_id',
                    'region_id',
                    'address',
                    'architecture',
                    'total_vcpus',
                    'total_memory_mb',
                    'total_disk_mb',
                    'runtime_cohort'
                ],
                properties: {
                    provider_id: {
                        type: 'string',
                        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                    },
                    region_id: {
                        type: 'string',
                        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                    },
                    address: {
                        type: 'string',
                        description: 'Literal address in the configured managed-host overlay.'
                    },
                    architecture: { type: 'string', enum: ['x86_64', 'aarch64'] },
                    total_vcpus: { type: 'integer', minimum: 1, maximum: 4096 },
                    total_memory_mb: { type: 'integer', minimum: 1, maximum: 16_777_216 },
                    total_disk_mb: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 9_007_199_254_740_991
                    },
                    ttl_seconds: { type: 'integer', minimum: 60, maximum: 1800, default: 600 },
                    runtime_cohort: schemaRef('RuntimeCohort')
                },
                additionalProperties: false
            },
            HostEnrollmentResponse: {
                type: 'object',
                required: ['id', 'host_id', 'token', 'expires_at', 'secret_displayed_once'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    host_id: { type: 'string', format: 'uuid' },
                    token: {
                        type: 'string',
                        pattern: '^nhe_[A-Za-z0-9_-]{43}$',
                        readOnly: true,
                        description: '256-bit one-use host enrollment grant. Store only in the private per-host provisioning input.'
                    },
                    expires_at: { type: 'string', format: 'date-time' },
                    secret_displayed_once: { type: 'boolean', const: true }
                },
                additionalProperties: false
            },
            HostLifecycle: {
                type: 'object',
                required: [
                    'id',
                    'desired_state',
                    'credential_generation',
                    'credential_status',
                    'credential_rotated_at'
                ],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    desired_state: {
                        type: 'string',
                        enum: ['active', 'draining', 'quarantined', 'revoked']
                    },
                    credential_generation: { type: 'integer', minimum: 1 },
                    credential_status: { type: 'string', enum: ['active', 'revoked'] },
                    credential_rotated_at: { type: 'string', format: 'date-time' },
                    credential_revoked_at: { type: 'string', format: 'date-time' },
                    lifecycle_reason: { type: 'string', minLength: 1, maxLength: 512 }
                },
                additionalProperties: false
            },
            HostLifecycleRequest: {
                type: 'object',
                properties: { reason: { type: 'string', minLength: 1, maxLength: 512 } },
                additionalProperties: false
            },
            HostLifecycleResponse: {
                type: 'object',
                required: ['host'],
                properties: { host: schemaRef('HostLifecycle') },
                additionalProperties: false
            },
            RotateHostCredentialsRequest: {
                type: 'object',
                required: ['control_token', 'gateway_token'],
                properties: {
                    control_token: {
                        type: 'string',
                        minLength: 32,
                        description: 'Must differ from gateway_token.'
                    },
                    gateway_token: {
                        type: 'string',
                        minLength: 32,
                        description: 'Must differ from control_token.'
                    },
                    reason: { type: 'string', minLength: 1, maxLength: 512 }
                },
                additionalProperties: false
            },
            RotateHostCredentialsResponse: {
                type: 'object',
                required: ['host', 'credential', 'secret_displayed_once'],
                properties: {
                    host: schemaRef('HostLifecycle'),
                    credential: { type: 'string', pattern: '^nh_[0-9a-f]{64}$', readOnly: true },
                    secret_displayed_once: { type: 'boolean', const: true }
                },
                additionalProperties: false
            },
            BillingAccount: {
                type: 'object',
                required: ['plan'],
                properties: {
                    plan: { type: 'string' },
                    spend_cap_cents: { type: ['integer', 'null'], minimum: 0 },
                    delinquent_at: { type: ['string', 'null'], format: 'date-time' }
                },
                additionalProperties: false
            },
            UsageDimension: {
                type: 'string',
                enum: [
                    'vcpu_seconds',
                    'gib_seconds',
                    'storage_gib_hours',
                    'egress_bytes',
                    'inference_units'
                ]
            },
            UsageRecord: {
                type: 'object',
                required: ['usage_date', 'project_id', 'dimension', 'quantity'],
                properties: {
                    usage_date: { type: 'string', format: 'date' },
                    project_id: { type: 'string', format: 'uuid' },
                    dimension: schemaRef('UsageDimension'),
                    quantity: { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]+)?$' }
                },
                additionalProperties: false
            },
            UsageResponse: {
                type: 'object',
                required: ['account', 'usage'],
                properties: {
                    account: schemaRef('BillingAccount'),
                    usage: { type: 'array', items: schemaRef('UsageRecord') }
                },
                additionalProperties: false
            },
            StripeWebhookResponse: {
                type: 'object',
                required: ['received', 'replayed'],
                properties: {
                    received: { type: 'boolean', const: true },
                    replayed: { type: 'boolean' }
                },
                additionalProperties: false
            }
        }
    },
    security: [{ bearerAuth: [] }],
    paths: {
        '/v1/auth/device/code': {
            post: {
                operationId: 'issueDeviceCode',
                security: [],
                requestBody: jsonRequest('DeviceCodeRequest'),
                responses: {
                    '201': jsonResponse('Short-lived device and human authorization codes', 'DeviceCodeResponse'),
                    ...errors(400, 413, 429, 500)
                }
            }
        },
        '/v1/auth/device/inspect': {
            post: {
                operationId: 'inspectDeviceAuthorization',
                requestBody: jsonRequest('InspectDeviceCodeRequest'),
                responses: {
                    '200': jsonResponse('Pending requested scopes for explicit review', 'DeviceAuthorizationRequest'),
                    ...errors(400, 401, 404, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/auth/device/authorize': {
            post: {
                operationId: 'authorizeDevice',
                requestBody: jsonRequest('AuthorizeDeviceRequest'),
                responses: {
                    '200': jsonResponse('One-time approval or denial recorded', 'DeviceAuthorizationDecision'),
                    ...errors(400, 401, 403, 404, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/auth/device/token': {
            post: {
                operationId: 'exchangeDeviceCode',
                security: [],
                requestBody: jsonRequest('ExchangeDeviceCodeRequest'),
                responses: {
                    '200': jsonResponse('One-time access and refresh credential response', 'DeviceTokenResponse'),
                    ...errors(400, 413, 429, 500)
                }
            }
        },
        '/v1/auth/device/refresh': {
            post: {
                operationId: 'refreshDeviceCredential',
                security: [],
                requestBody: jsonRequest('RefreshDeviceTokenRequest'),
                responses: {
                    '200': jsonResponse('Rotated refresh credential and short-lived access token', 'DeviceTokenResponse'),
                    ...errors(400, 413, 429, 500, 503)
                }
            }
        },
        '/v1/auth/device/revoke': {
            post: {
                operationId: 'revokeDeviceCredential',
                security: [],
                requestBody: jsonRequest('RefreshDeviceTokenRequest'),
                responses: {
                    '204': { description: 'Refresh family and active access tokens revoked idempotently' },
                    ...errors(400, 413, 500)
                }
            }
        },
        '/v1/organizations': {
            get: {
                operationId: 'listOrganizations',
                responses: {
                    '200': jsonResponse('Organizations visible to the dashboard user', 'OrganizationList'),
                    ...errors(403, 429, 500, 503)
                }
            }
        },
        '/v1/projects': {
            get: {
                operationId: 'listProjects',
                responses: {
                    '200': jsonResponse('Tenant-scoped projects', 'ProjectList'),
                    ...errors(401, 429, 500, 503)
                }
            },
            post: {
                operationId: 'createProject',
                requestBody: jsonRequest('CreateProjectRequest'),
                responses: {
                    '200': jsonResponse('Existing project replayed by organization and slug', 'Project'),
                    '201': jsonResponse('Created project', 'Project'),
                    ...errors(400, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/api-keys': {
            get: {
                operationId: 'listApiKeys',
                parameters: [projectQuery],
                responses: {
                    '200': jsonResponse('API key summaries without secrets', 'ApiKeyList'),
                    ...errors(403, 429, 500, 503)
                }
            },
            post: {
                operationId: 'createApiKey',
                requestBody: jsonRequest('CreateApiKeyRequest'),
                responses: {
                    '201': jsonResponse('One-time API key secret', 'CreateApiKeyResponse'),
                    ...errors(400, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/api-keys/{id}': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            delete: {
                operationId: 'revokeApiKey',
                responses: {
                    '204': { description: 'API key revoked; repeated revocation remains successful' },
                    ...errors(400, 403, 404, 429, 500, 503)
                }
            }
        },
        '/v1/api-keys/{id}/disable': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'disableApiKey',
                responses: {
                    '204': { description: 'API key disabled and its outstanding grants revoked' },
                    ...errors(400, 403, 404, 429, 500, 503)
                }
            }
        },
        '/v1/api-keys/{id}/enable': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'enableApiKey',
                responses: {
                    '204': { description: 'API key enabled; previously revoked grants remain revoked' },
                    ...errors(400, 403, 404, 429, 500, 503)
                }
            }
        },
        '/v1/api-keys/{id}/rotate': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'rotateApiKey',
                responses: {
                    '201': jsonResponse('One-time replacement API key secret', 'RotateApiKeyResponse'),
                    ...errors(400, 403, 404, 409, 429, 500, 503)
                }
            }
        },
        '/v1/operator/identity-provider/sync': {
            post: {
                operationId: 'syncIdentityProviderLifecycle',
                description: 'Explicit fleet-operator Clerk lifecycle synchronization. Events map only to existing immutable local subjects and explicit local organization UUIDs; raw provider payloads and credentials are never retained.',
                requestBody: jsonRequest('IdentityProviderSyncRequest'),
                responses: {
                    '200': jsonResponse('Applied, stale, or replayed identity-provider event', 'IdentityProviderSyncResponse'),
                    ...errors(400, 401, 403, 404, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/users/{id}/disable': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'disableUserIdentity',
                requestBody: jsonRequest('IdentityLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Disabled user identity state', 'UserIdentityLifecycleResponse'),
                    ...errors(400, 401, 403, 404, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/users/{id}/enable': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'enableUserIdentity',
                requestBody: jsonRequest('IdentityLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Enabled user identity state', 'UserIdentityLifecycleResponse'),
                    ...errors(400, 401, 403, 404, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/organizations/{id}/disable': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'disableOrganizationIdentity',
                requestBody: jsonRequest('IdentityLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Disabled organization identity state', 'OrganizationIdentityLifecycleResponse'),
                    ...errors(400, 401, 403, 404, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/organizations/{id}/enable': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'enableOrganizationIdentity',
                requestBody: jsonRequest('IdentityLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Enabled organization identity state', 'OrganizationIdentityLifecycleResponse'),
                    ...errors(400, 401, 403, 404, 413, 429, 500, 503)
                }
            }
        },
        '/v1/machines': {
            get: {
                operationId: 'listMachines',
                parameters: [
                    projectQuery,
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: { type: 'string', pattern: '^m_[A-Za-z0-9_-]{1,126}$' }
                    },
                    {
                        name: 'limit',
                        in: 'query',
                        required: false,
                        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
                    }
                ],
                responses: {
                    '200': jsonResponse('Machine page', 'MachineList'),
                    ...errors(401, 403, 429, 500, 503)
                }
            },
            post: {
                operationId: 'createMachine',
                parameters: [idempotencyKey],
                requestBody: jsonRequest('CreateMachineRequest'),
                responses: {
                    '200': jsonResponse('Durable create result replayed', 'Machine'),
                    '201': jsonResponse('Machine ready', 'Machine'),
                    '202': jsonResponse('Machine accepted and starting', 'Machine'),
                    ...errors(400, 401, 403, 409, 413, 429, 500, 501, 502, 503)
                }
            }
        },
        '/v1/machines/{id}': {
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            get: {
                operationId: 'getMachine',
                responses: {
                    '200': jsonResponse('Machine', 'Machine'),
                    ...errors(404, 429, 500, 503)
                }
            },
            delete: {
                operationId: 'destroyMachine',
                responses: {
                    '204': { description: 'Machine stopped' },
                    ...errors(404, 429, 500, 503)
                }
            }
        },
        '/v1/machines/{id}/extend': {
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$'), idempotencyKey],
            post: {
                operationId: 'extendMachine',
                requestBody: jsonRequest('ExtendMachineRequest'),
                responses: {
                    '200': jsonResponse('Machine with updated expiry', 'Machine'),
                    ...errors(400, 404, 409, 413, 429, 500, 501, 502, 503)
                }
            }
        },
        '/v1/machines/{id}/fork': {
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$'), idempotencyKey],
            post: {
                operationId: 'forkMachine',
                requestBody: jsonRequest('ForkMachineRequest'),
                responses: {
                    '200': {
                        description: 'Durable single or batch fork result replayed',
                        content: {
                            'application/json': {
                                schema: {
                                    oneOf: [schemaRef('Machine'), schemaRef('MachineBatch')]
                                }
                            }
                        }
                    },
                    '201': {
                        description: 'Single or complete batch fork created',
                        content: {
                            'application/json': {
                                schema: {
                                    oneOf: [schemaRef('Machine'), schemaRef('MachineBatch')]
                                }
                            }
                        }
                    },
                    '202': jsonResponse('Fork has an ambiguous host result', 'PendingForkResponse'),
                    ...errors(400, 404, 409, 413, 422, 429, 500, 501, 502, 503)
                }
            }
        },
        '/v1/machines/{id}/exec': {
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            post: {
                operationId: 'execMachine',
                requestBody: jsonRequest('ExecMachineRequest'),
                responses: {
                    '200': jsonResponse('Guest execution result', 'ExecResult'),
                    ...errors(400, 404, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/machines/{id}/sessions': {
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            post: {
                operationId: 'createMachineSession',
                description: 'Issues a revocable managed gateway session. The host-local agent capability is deliberately unsupported and returns typed 501 before grant persistence.',
                requestBody: jsonRequest('CreateMachineSessionRequest'),
                responses: {
                    '200': jsonResponse('Short-lived gateway capability', 'MachineSession'),
                    ...errors(400, 404, 409, 413, 429, 500, 501, 503)
                }
            }
        },
        '/v1/machines/{id}/sessions/{sessionId}': {
            parameters: [
                pathId('^m_[A-Za-z0-9_-]{1,126}$'),
                {
                    name: 'sessionId',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', format: 'uuid' }
                }
            ],
            delete: {
                operationId: 'revokeMachineSession',
                responses: {
                    '204': { description: 'Machine session revoked or already revoked' },
                    ...errors(404, 429, 500, 503)
                }
            }
        },
        '/v1/machines/{id}/upload': {
            servers: [{ url: 'https://gateway.boringcomputers.com' }],
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            post: {
                operationId: 'uploadMachineFile',
                security: [{ machineCapability: [] }],
                parameters: [
                    {
                        name: 'X-Filename',
                        in: 'header',
                        required: true,
                        schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,255}$' }
                    }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/octet-stream': {
                            schema: { type: 'string', format: 'binary', maxLength: 16_777_216 }
                        }
                    }
                },
                responses: {
                    '200': jsonResponse('File stored under /root', 'FileUploadResult'),
                    ...errors(400, 401, 403, 404, 409, 413, 429),
                    ...proxiedDataPlaneErrors(502, 503)
                }
            }
        },
        '/v1/machines/{id}/download': {
            servers: [{ url: 'https://gateway.boringcomputers.com' }],
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            get: {
                operationId: 'downloadMachineFile',
                security: [{ machineCapability: [] }],
                parameters: [
                    {
                        name: 'path',
                        in: 'query',
                        required: true,
                        schema: { type: 'string', pattern: '^/(?!.*(?:^|/)\\.\\.(?:/|$)).+$' }
                    }
                ],
                responses: {
                    '200': {
                        description: 'Bounded guest file bytes',
                        content: {
                            'application/octet-stream': {
                                schema: { type: 'string', format: 'binary', maxLength: 16_777_216 }
                            }
                        }
                    },
                    ...errors(400, 401, 403, 404, 409, 413, 429),
                    ...proxiedDataPlaneErrors(502, 503)
                }
            },
            head: {
                operationId: 'inspectMachineFile',
                security: [{ machineCapability: [] }],
                parameters: [
                    {
                        name: 'path',
                        in: 'query',
                        required: true,
                        schema: { type: 'string', pattern: '^/(?!.*(?:^|/)\\.\\.(?:/|$)).+$' }
                    }
                ],
                responses: {
                    '200': { description: 'Bounded guest file metadata' },
                    ...errors(400, 401, 403, 404, 409, 413, 429),
                    ...proxiedDataPlaneErrors(502, 503)
                }
            }
        },
        '/v1/machines/{id}/tty': {
            servers: [{ url: 'wss://gateway.boringcomputers.com' }],
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            get: {
                operationId: 'connectMachineTty',
                security: [{ websocketCapability: [] }],
                parameters: websocketUpgradeParameters,
                responses: {
                    '101': websocketSwitchingProtocols,
                    ...websocketErrors(400, 401, 403, 404, 409, 413, 426, 429, 502, 503)
                },
                'x-nehemiah-websocket': websocketContract({
                    capability: 'tty',
                    clientFrames: ['binary', 'text'],
                    serverFrames: ['binary'],
                    maxClientFrameBytes: 65_536
                })
            }
        },
        '/v1/machines/{id}/vnc': {
            servers: [{ url: 'wss://gateway.boringcomputers.com' }],
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            get: {
                operationId: 'connectMachineVnc',
                security: [{ websocketCapability: [] }],
                parameters: websocketUpgradeParameters,
                responses: {
                    '101': websocketSwitchingProtocols,
                    ...websocketErrors(400, 401, 403, 404, 409, 413, 426, 429, 502, 503)
                },
                'x-nehemiah-websocket': websocketContract({
                    capability: 'vnc',
                    clientFrames: ['binary', 'text'],
                    serverFrames: ['binary'],
                    maxClientFrameBytes: 1_048_576
                })
            }
        },
        '/v1/machines/{id}/agent': {
            servers: [{ url: 'wss://gateway.boringcomputers.com' }],
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            get: {
                operationId: 'connectMachineDesktopAgent',
                deprecated: true,
                description: 'Local/self-hosted compatibility route only. Managed cloud does not issue the required agent capability or distribute a provider model credential.',
                security: [{ websocketCapability: [] }],
                parameters: websocketUpgradeParameters,
                responses: {
                    '101': websocketSwitchingProtocols,
                    ...websocketErrors(400, 401, 403, 404, 409, 413, 426, 429, 502, 503)
                },
                'x-nehemiah-websocket': websocketContract({
                    capability: 'agent',
                    clientFrames: ['text'],
                    serverFrames: ['text'],
                    maxClientFrameBytes: 65_536,
                    maxLifetimeSeconds: 300,
                    initialFrame: {
                        required: true,
                        type: 'text',
                        deadline_seconds: 5,
                        format: 'Exact UTF-8 JSON object {"type":"start","version":1,"goal":"..."}; unknown fields are rejected.',
                        goal_utf8_bytes: { minimum: 1, maximum: 4_096, trimmed: true },
                        invalid_close_codes: { policy_violation: 1008, message_too_big: 1009 }
                    }
                })
            }
        },
        '/v1/machines/{id}/shell-agent': {
            servers: [{ url: 'wss://gateway.boringcomputers.com' }],
            parameters: [pathId('^m_[A-Za-z0-9_-]{1,126}$')],
            get: {
                operationId: 'connectMachineShellAgent',
                deprecated: true,
                description: 'Local/self-hosted compatibility route only. Managed cloud does not issue the required agent capability or distribute a provider model credential.',
                security: [{ websocketCapability: [] }],
                parameters: [
                    ...websocketUpgradeParameters,
                    {
                        name: 'goal',
                        in: 'query',
                        required: false,
                        deprecated: true,
                        schema: { type: 'string', minLength: 1, maxLength: 400 },
                        description: 'Legacy local/self-hosted compatibility only. Managed clients MUST omit this query and send the start frame after upgrade.'
                    }
                ],
                responses: {
                    '101': websocketSwitchingProtocols,
                    ...websocketErrors(400, 401, 403, 404, 409, 413, 426, 429, 502, 503)
                },
                'x-nehemiah-websocket': websocketContract({
                    capability: 'agent',
                    clientFrames: ['text'],
                    serverFrames: ['text'],
                    maxClientFrameBytes: 65_536,
                    maxLifetimeSeconds: 300,
                    initialFrame: {
                        required: true,
                        type: 'text',
                        deadline_seconds: 5,
                        format: 'Exact UTF-8 JSON object {"type":"start","version":1,"goal":"..."}; unknown fields are rejected.',
                        goal_utf8_bytes: { minimum: 1, maximum: 4_096, trimmed: true },
                        invalid_close_codes: { policy_violation: 1008, message_too_big: 1009 }
                    }
                })
            }
        },
        '/v1/capability/exchange': {
            servers: [{ url: 'https://gateway.boringcomputers.com' }],
            post: {
                operationId: 'exchangePreviewCapability',
                security: [{ machineCapability: [] }],
                responses: {
                    '204': {
                        description: 'Preview capability exchanged for a scoped HttpOnly cookie',
                        headers: {
                            'Set-Cookie': {
                                description: 'Short-lived Secure, SameSite=Strict preview cookie scoped to the isolated preview origin',
                                schema: { type: 'string' }
                            }
                        }
                    },
                    ...gatewayErrors(400, 401, 404, 413, 421, 429, 502, 503)
                }
            }
        },
        '/v1/templates': {
            get: {
                operationId: 'listManagedTemplates',
                parameters: [projectQuery],
                responses: {
                    '200': jsonResponse('Tenant-scoped immutable template versions', 'ManagedTemplateList'),
                    ...errors(401, 403, 429, 500, 503)
                }
            },
            post: {
                operationId: 'publishManagedTemplate',
                deprecated: true,
                description: 'Managed custom-template publication is disabled in production until aggregate tenant/host-cache quotas and durable eviction are enforced. Production returns 503 without exporting or persisting a template.',
                requestBody: jsonRequest('PublishTemplateRequest'),
                responses: {
                    '201': jsonResponse('Published immutable template version', 'ManagedTemplate'),
                    ...errors(400, 401, 403, 404, 409, 413, 429, 500, 502, 503)
                }
            }
        },
        '/v1/templates/{id}': {
            parameters: [pathId('^[0-9a-f-]{36}$'), projectQuery],
            delete: {
                operationId: 'deleteManagedTemplate',
                responses: {
                    '204': { description: 'Template version retired' },
                    ...errors(401, 403, 404, 409, 429, 500, 503)
                }
            }
        },
        '/v1/volumes': {
            get: {
                operationId: 'listVolumes',
                deprecated: true,
                description: managedVolumeDisabledDescription,
                parameters: [projectQuery],
                responses: {
                    '200': jsonResponse('Tenant-scoped volume list', 'VolumeList'),
                    ...errors(400, 401, 403, 429, 500, 503)
                }
            },
            post: {
                operationId: 'createVolume',
                deprecated: true,
                description: managedVolumeDisabledDescription,
                parameters: [idempotencyKey],
                requestBody: jsonRequest('CreateVolumeRequest'),
                responses: {
                    '200': jsonResponse('Durable volume result replayed with PUT grant', 'VolumeWithGrant'),
                    '201': jsonResponse('Volume metadata and initial PUT grant', 'VolumeWithGrant'),
                    ...errors(400, 401, 403, 404, 409, 413, 429, 500, 502, 503)
                }
            }
        },
        '/v1/volumes/{id}': {
            parameters: [pathId('^vol_[A-Za-z0-9_-]{22}$')],
            get: {
                operationId: 'getVolume',
                deprecated: true,
                description: managedVolumeDisabledDescription,
                responses: {
                    '200': jsonResponse('Volume metadata', 'Volume'),
                    ...errors(404, 429, 500, 503)
                }
            },
            delete: {
                operationId: 'deleteVolume',
                deprecated: true,
                description: managedVolumeDisabledDescription,
                responses: {
                    '204': {
                        description: 'Soft-deleted with retained object cleanup scheduled',
                        headers: {
                            'x-volume-delete-after': {
                                description: 'Durable retention boundary',
                                schema: { type: 'string', format: 'date-time' }
                            }
                        }
                    },
                    ...errors(404, 429, 500, 502, 503)
                }
            }
        },
        '/v1/volumes/{id}/grants': {
            parameters: [pathId('^vol_[A-Za-z0-9_-]{22}$')],
            post: {
                operationId: 'createVolumeGrant',
                deprecated: true,
                description: managedVolumeDisabledDescription,
                requestBody: jsonRequest('CreateVolumeGrantRequest'),
                responses: {
                    '200': jsonResponse('Volume and one short-lived scoped grant', 'VolumeGrantResponse'),
                    ...errors(400, 401, 403, 404, 413, 429, 500, 502, 503)
                }
            }
        },
        '/v1/volume-objects/{capabilityId}': {
            parameters: [
                {
                    name: 'capabilityId',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }
                }
            ],
            get: {
                operationId: 'downloadVolumeRevision',
                deprecated: true,
                description: managedVolumeDisabledDescription,
                security: [{ volumeCapability: [] }],
                responses: {
                    '200': {
                        description: 'Latest checksum-verified immutable volume revision',
                        content: {
                            'application/octet-stream': {
                                schema: { type: 'string', format: 'binary' }
                            }
                        }
                    },
                    ...errors(400, 401, 404, 409, 502, 503)
                }
            },
            put: {
                operationId: 'uploadVolumeRevision',
                deprecated: true,
                description: managedVolumeDisabledDescription,
                security: [{ volumeCapability: [] }],
                parameters: [
                    {
                        name: 'x-nehemiah-content-sha256',
                        in: 'header',
                        required: true,
                        schema: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }
                    }
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/octet-stream': { schema: { type: 'string', format: 'binary' } }
                    }
                },
                responses: {
                    '201': { description: 'Immutable encrypted revision stored and checksum verified' },
                    '204': { description: 'Byte-identical reservation replay' },
                    ...errors(400, 401, 409, 413, 502, 503)
                }
            }
        },
        '/v1/operator/host-enrollments': {
            post: {
                operationId: 'issueHostEnrollment',
                description: 'Fleet-operator-only issuance of a short-lived, one-use grant bound to one provider identity, overlay address, architecture, and capacity.',
                requestBody: jsonRequest('CreateHostEnrollmentRequest'),
                responses: {
                    '201': jsonResponse('One-time host enrollment grant; the token is displayed once', 'HostEnrollmentResponse'),
                    ...errors(400, 401, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/host-enrollments/{id}/revoke': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'revokeHostEnrollment',
                description: 'Fleet-operator-only revocation of an unconsumed enrollment grant.',
                responses: {
                    '204': { description: 'Enrollment grant revoked' },
                    ...errors(400, 401, 403, 409, 429, 500, 503)
                }
            }
        },
        '/v1/operator/hosts/{id}/drain': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'drainHost',
                requestBody: jsonRequest('HostLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Host placed in draining state', 'HostLifecycleResponse'),
                    ...errors(400, 401, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/hosts/{id}/activate': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'activateHost',
                requestBody: jsonRequest('HostLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Host returned to active state', 'HostLifecycleResponse'),
                    ...errors(400, 401, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/hosts/{id}/quarantine': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'quarantineHost',
                requestBody: jsonRequest('HostLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Host quarantined and credentials revoked', 'HostLifecycleResponse'),
                    ...errors(400, 401, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/hosts/{id}/revoke': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'revokeHost',
                requestBody: jsonRequest('HostLifecycleRequest'),
                responses: {
                    '200': jsonResponse('Host permanently revoked', 'HostLifecycleResponse'),
                    ...errors(400, 401, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/operator/hosts/{id}/credentials/rotate': {
            parameters: [pathId('^[0-9a-f-]{36}$')],
            post: {
                operationId: 'rotateHostCredentials',
                requestBody: jsonRequest('RotateHostCredentialsRequest'),
                responses: {
                    '200': jsonResponse('Rotated one-time host credential and lifecycle state', 'RotateHostCredentialsResponse'),
                    ...errors(400, 401, 403, 409, 413, 429, 500, 503)
                }
            }
        },
        '/v1/billing/usage': {
            get: {
                operationId: 'getBillingUsage',
                parameters: [
                    {
                        name: 'from',
                        in: 'query',
                        required: false,
                        schema: { type: 'string', format: 'date-time' }
                    },
                    {
                        name: 'to',
                        in: 'query',
                        required: false,
                        schema: { type: 'string', format: 'date-time' }
                    },
                    projectQuery
                ],
                responses: {
                    '200': jsonResponse('Billing account and daily usage records', 'UsageResponse'),
                    ...errors(401, 403, 429, 500, 503)
                }
            }
        },
        '/v1/webhooks/stripe': {
            post: {
                operationId: 'receiveStripeWebhook',
                security: [],
                parameters: [
                    {
                        name: 'stripe-signature',
                        in: 'header',
                        required: true,
                        schema: { type: 'string' }
                    }
                ],
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object' } } }
                },
                responses: {
                    '200': jsonResponse('Webhook receipt and replay state', 'StripeWebhookResponse'),
                    ...errors(400, 413, 500, 503)
                }
            }
        }
    }
};
export const openapi = () => json(openApiDocument);
//# sourceMappingURL=openapi.js.map