import { type Handler } from './router.js';
export declare const openApiDocument: {
    readonly openapi: "3.1.0";
    readonly info: {
        readonly title: "Nehemiah API";
        readonly version: "1.0.0-beta.1";
    };
    readonly servers: readonly [{
        readonly url: "https://api.boringcomputers.com";
    }];
    readonly components: {
        readonly securitySchemes: {
            readonly apiKey: {
                readonly type: "http";
                readonly scheme: "bearer";
                readonly bearerFormat: "bc_...";
            };
        };
        readonly schemas: {
            readonly Machine: {
                readonly type: "object";
                readonly required: readonly ["id", "project_id", "state", "ready", "region", "resources", "created_at", "expires_at"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly pattern: "^m_";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly state: {
                        readonly type: "string";
                        readonly enum: readonly ["requested", "placing", "starting", "running", "stopping", "stopped", "failed", "lost"];
                    };
                    readonly ready: {
                        readonly type: "boolean";
                    };
                    readonly region: {
                        readonly type: "string";
                    };
                    readonly architecture: {
                        readonly type: "string";
                        readonly enum: readonly ["x86_64", "aarch64"];
                    };
                    readonly resources: {
                        readonly type: "object";
                        readonly properties: {
                            readonly vcpus: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                            readonly memory_mb: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                            readonly disk_mb: {
                                readonly type: "integer";
                                readonly minimum: 1;
                            };
                        };
                    };
                    readonly created_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly started_at: {
                        readonly type: readonly ["string", "null"];
                        readonly format: "date-time";
                    };
                    readonly ready_at: {
                        readonly type: readonly ["string", "null"];
                        readonly format: "date-time";
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
            };
            readonly Problem: {
                readonly type: "object";
                readonly required: readonly ["type", "title", "status", "detail"];
                readonly properties: {
                    readonly type: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly type: "integer";
                    };
                    readonly detail: {
                        readonly type: "string";
                    };
                    readonly request_id: {
                        readonly type: "string";
                    };
                };
            };
        };
    };
    readonly security: readonly [{
        readonly apiKey: readonly [];
    }];
    readonly paths: {
        readonly '/v1/machines': {
            readonly get: {
                readonly operationId: "listMachines";
                readonly responses: {
                    readonly '200': {
                        readonly description: "Machine list";
                    };
                };
            };
            readonly post: {
                readonly operationId: "createMachine";
                readonly parameters: readonly [{
                    readonly name: "Idempotency-Key";
                    readonly in: "header";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly '201': {
                        readonly description: "Machine ready";
                    };
                    readonly '202': {
                        readonly description: "Machine starting";
                    };
                    readonly '429': {
                        readonly description: "Quota exceeded";
                    };
                    readonly '503': {
                        readonly description: "Capacity unavailable";
                    };
                };
            };
        };
        readonly '/v1/machines/{id}': {
            readonly parameters: readonly [{
                readonly name: "id";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                };
            }];
            readonly get: {
                readonly operationId: "getMachine";
                readonly responses: {
                    readonly '200': {
                        readonly description: "Machine";
                    };
                };
            };
            readonly delete: {
                readonly operationId: "destroyMachine";
                readonly responses: {
                    readonly '204': {
                        readonly description: "Stopped";
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/extend': {
            readonly post: {
                readonly operationId: "extendMachine";
                readonly responses: {
                    readonly '200': {
                        readonly description: "Extended";
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/exec': {
            readonly post: {
                readonly operationId: "execMachine";
                readonly responses: {
                    readonly '200': {
                        readonly description: "Execution result";
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/sessions': {
            readonly post: {
                readonly operationId: "createMachineSession";
                readonly responses: {
                    readonly '200': {
                        readonly description: "Short-lived gateway token";
                    };
                };
            };
        };
    };
};
export declare const openapi: Handler;
