import { json } from './router.js';
export const openApiDocument = {
    openapi: '3.1.0',
    info: { title: 'Nehemiah API', version: '1.0.0-beta.1' },
    servers: [{ url: 'https://api.boringcomputers.com' }],
    components: {
        securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'bc_...' } },
        schemas: {
            Machine: {
                type: 'object',
                required: ['id', 'project_id', 'state', 'ready', 'region', 'resources', 'created_at', 'expires_at'],
                properties: {
                    id: { type: 'string', pattern: '^m_' },
                    project_id: { type: 'string', format: 'uuid' },
                    state: {
                        type: 'string',
                        enum: ['requested', 'placing', 'starting', 'running', 'stopping', 'stopped', 'failed', 'lost']
                    },
                    ready: { type: 'boolean' },
                    region: { type: 'string' },
                    architecture: { type: 'string', enum: ['x86_64', 'aarch64'] },
                    resources: {
                        type: 'object',
                        properties: {
                            vcpus: { type: 'integer', minimum: 1 },
                            memory_mb: { type: 'integer', minimum: 1 },
                            disk_mb: { type: 'integer', minimum: 1 }
                        }
                    },
                    created_at: { type: 'string', format: 'date-time' },
                    started_at: { type: ['string', 'null'], format: 'date-time' },
                    ready_at: { type: ['string', 'null'], format: 'date-time' },
                    expires_at: { type: 'string', format: 'date-time' }
                }
            },
            Problem: {
                type: 'object',
                required: ['type', 'title', 'status', 'detail'],
                properties: {
                    type: { type: 'string', format: 'uri' },
                    title: { type: 'string' },
                    status: { type: 'integer' },
                    detail: { type: 'string' },
                    request_id: { type: 'string' }
                }
            }
        }
    },
    security: [{ apiKey: [] }],
    paths: {
        '/v1/machines': {
            get: { operationId: 'listMachines', responses: { '200': { description: 'Machine list' } } },
            post: {
                operationId: 'createMachine',
                parameters: [
                    { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    '201': { description: 'Machine ready' },
                    '202': { description: 'Machine starting' },
                    '429': { description: 'Quota exceeded' },
                    '503': { description: 'Capacity unavailable' }
                }
            }
        },
        '/v1/machines/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            get: { operationId: 'getMachine', responses: { '200': { description: 'Machine' } } },
            delete: { operationId: 'destroyMachine', responses: { '204': { description: 'Stopped' } } }
        },
        '/v1/machines/{id}/extend': {
            post: { operationId: 'extendMachine', responses: { '200': { description: 'Extended' } } }
        },
        '/v1/machines/{id}/exec': {
            post: { operationId: 'execMachine', responses: { '200': { description: 'Execution result' } } }
        },
        '/v1/machines/{id}/sessions': {
            post: { operationId: 'createMachineSession', responses: { '200': { description: 'Short-lived gateway token' } } }
        }
    }
};
export const openapi = () => json(openApiDocument);
//# sourceMappingURL=openapi.js.map