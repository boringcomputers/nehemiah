import { type Handler } from './router.js';
export declare const openApiDocument: {
    readonly openapi: "3.1.0";
    readonly info: {
        readonly title: "Nehemiah API";
        readonly version: "1.0.0-beta.1";
        readonly description: "Public Boring Computers control-plane and capability-gateway HTTP contract. WebSocket byte channels are documented separately.";
    };
    readonly servers: readonly [{
        readonly url: "https://api.boringcomputers.com";
    }];
    readonly components: {
        readonly securitySchemes: {
            readonly bearerAuth: {
                readonly type: "http";
                readonly scheme: "bearer";
                readonly bearerFormat: "bc_... or dashboard session";
            };
            readonly machineCapability: {
                readonly type: "http";
                readonly scheme: "bearer";
                readonly bearerFormat: "short-lived machine capability";
            };
            readonly websocketCapability: {
                readonly type: "apiKey";
                readonly in: "header";
                readonly name: "Sec-WebSocket-Protocol";
                readonly description: "Short-lived machine capability prefixed with nehemiah.capability.; credentials in the URL are forbidden.";
            };
            readonly volumeCapability: {
                readonly type: "apiKey";
                readonly in: "header";
                readonly name: "x-nehemiah-volume-capability";
            };
        };
        readonly schemas: {
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
                        readonly minimum: 400;
                        readonly maximum: 599;
                    };
                    readonly detail: {
                        readonly type: "string";
                    };
                    readonly request_id: {
                        readonly type: "string";
                        readonly maxLength: 128;
                    };
                    readonly operation_may_have_completed: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: true;
            };
            readonly DataPlaneError: {
                readonly type: "object";
                readonly required: readonly ["error"];
                readonly properties: {
                    readonly error: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 4096;
                    };
                    readonly feature: {
                        readonly type: "string";
                        readonly maxLength: 128;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly Organization: {
                readonly type: "object";
                readonly required: readonly ["id", "slug", "name"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly slug: {
                        readonly type: "string";
                    };
                    readonly name: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly OrganizationList: {
                readonly type: "object";
                readonly required: readonly ["organizations"];
                readonly properties: {
                    readonly organizations: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly Project: {
                readonly type: "object";
                readonly required: readonly ["id", "organization_id", "slug", "name", "max_machines", "max_vcpus", "max_memory_mb", "max_disk_mb", "max_storage_mb"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly organization_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly slug: {
                        readonly type: "string";
                        readonly pattern: "^[a-z0-9][a-z0-9-]{1,62}$";
                    };
                    readonly name: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 160;
                    };
                    readonly max_machines: {
                        readonly type: "integer";
                        readonly minimum: 0;
                    };
                    readonly max_vcpus: {
                        readonly type: "integer";
                        readonly minimum: 0;
                    };
                    readonly max_memory_mb: {
                        readonly type: "integer";
                        readonly minimum: 0;
                    };
                    readonly max_disk_mb: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                        readonly description: "Maximum active machine disk reservation in MiB.";
                    };
                    readonly max_storage_mb: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                        readonly description: "Maximum durable managed-volume allocation in MiB.";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ProjectList: {
                readonly type: "object";
                readonly required: readonly ["projects"];
                readonly properties: {
                    readonly projects: {
                        readonly type: "array";
                        readonly maxItems: 64;
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly CreateProjectRequest: {
                readonly type: "object";
                readonly required: readonly ["slug", "name"];
                readonly properties: {
                    readonly slug: {
                        readonly type: "string";
                        readonly pattern: "^[a-z0-9][a-z0-9-]{1,62}$";
                    };
                    readonly name: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 160;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ApiKeyScope: {
                readonly type: "string";
                readonly enum: readonly ["machines:read", "machines:write", "templates:read", "templates:write", "volumes:read", "volumes:write", "billing:read"];
            };
            readonly ApiKey: {
                readonly type: "object";
                readonly required: readonly ["id", "name", "prefix", "scopes"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly name: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 160;
                    };
                    readonly prefix: {
                        readonly type: "string";
                        readonly pattern: "^bc_(?:live|test)_[a-f0-9]{12}$";
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly items: {
                            $ref: string;
                        };
                    };
                    readonly created_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly last_used_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly disabled_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly revoked_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ApiKeyList: {
                readonly type: "object";
                readonly required: readonly ["api_keys"];
                readonly properties: {
                    readonly api_keys: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly CreateApiKeyRequest: {
                readonly type: "object";
                readonly required: readonly ["name", "scopes"];
                readonly properties: {
                    readonly name: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 160;
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly items: {
                            $ref: string;
                        };
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly CreateApiKeyResponse: {
                readonly type: "object";
                readonly required: readonly ["id", "key", "prefix", "secret_displayed_once"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly key: {
                        readonly type: "string";
                        readonly pattern: "^bc_(?:live|test)_[a-f0-9]{12}_[A-Za-z0-9_-]{32,}$";
                    };
                    readonly prefix: {
                        readonly type: "string";
                        readonly pattern: "^bc_(?:live|test)_[a-f0-9]{12}$";
                    };
                    readonly secret_displayed_once: {
                        readonly type: "boolean";
                        readonly const: true;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly RotateApiKeyResponse: {
                readonly type: "object";
                readonly required: readonly ["id", "key", "prefix", "rotated_from_id", "secret_displayed_once"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly key: {
                        readonly type: "string";
                        readonly pattern: "^bc_(?:live|test)_[a-f0-9]{12}_[A-Za-z0-9_-]{32,}$";
                        readonly readOnly: true;
                    };
                    readonly prefix: {
                        readonly type: "string";
                        readonly pattern: "^bc_(?:live|test)_[a-f0-9]{12}$";
                    };
                    readonly rotated_from_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly secret_displayed_once: {
                        readonly type: "boolean";
                        readonly const: true;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly IdentityLifecycleRequest: {
                readonly type: "object";
                readonly required: readonly ["reason"];
                readonly properties: {
                    readonly reason: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 512;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly IdentityLifecycleState: {
                readonly type: "object";
                readonly required: readonly ["id"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly disabled_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly UserIdentityLifecycleResponse: {
                readonly type: "object";
                readonly required: readonly ["user", "changed"];
                readonly properties: {
                    readonly user: {
                        $ref: string;
                    };
                    readonly changed: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly OrganizationIdentityLifecycleResponse: {
                readonly type: "object";
                readonly required: readonly ["organization", "changed"];
                readonly properties: {
                    readonly organization: {
                        $ref: string;
                    };
                    readonly changed: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly IdentityProviderSyncEventType: {
                readonly type: "string";
                readonly enum: readonly ["user.disabled", "user.deleted", "membership.upserted", "membership.removed"];
            };
            readonly IdentityProviderMembershipRole: {
                readonly type: "string";
                readonly enum: readonly ["owner", "admin", "member", "billing"];
            };
            readonly IdentityProviderSyncRequest: {
                readonly type: "object";
                readonly description: "A bounded, source-ordered Clerk lifecycle event. User events forbid organization_id/role; membership.upserted requires both; membership.removed requires organization_id and forbids role.";
                readonly required: readonly ["provider", "event_id", "source_version", "event_type", "clerk_user_id", "reason"];
                readonly oneOf: readonly [{
                    readonly properties: {
                        readonly event_type: {
                            readonly enum: readonly ["user.disabled", "user.deleted"];
                        };
                    };
                    readonly not: {
                        readonly anyOf: readonly [{
                            readonly required: readonly ["organization_id"];
                        }, {
                            readonly required: readonly ["role"];
                        }];
                    };
                }, {
                    readonly properties: {
                        readonly event_type: {
                            readonly const: "membership.upserted";
                        };
                    };
                    readonly required: readonly ["organization_id", "role"];
                }, {
                    readonly properties: {
                        readonly event_type: {
                            readonly const: "membership.removed";
                        };
                    };
                    readonly required: readonly ["organization_id"];
                    readonly not: {
                        readonly required: readonly ["role"];
                    };
                }];
                readonly properties: {
                    readonly provider: {
                        readonly type: "string";
                        readonly const: "clerk";
                    };
                    readonly event_id: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 128;
                        readonly pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
                    };
                    readonly source_version: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: number;
                    };
                    readonly event_type: {
                        $ref: string;
                    };
                    readonly clerk_user_id: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 256;
                        readonly pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";
                    };
                    readonly organization_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly role: {
                        $ref: string;
                    };
                    readonly reason: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 512;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly IdentityProviderSyncResponse: {
                readonly type: "object";
                readonly required: readonly ["provider", "event_id", "source_version", "result", "changed", "user_id"];
                readonly properties: {
                    readonly provider: {
                        readonly type: "string";
                        readonly const: "clerk";
                    };
                    readonly event_id: {
                        readonly type: "string";
                        readonly pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
                    };
                    readonly source_version: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: number;
                    };
                    readonly result: {
                        readonly type: "string";
                        readonly enum: readonly ["applied", "stale", "replayed"];
                    };
                    readonly changed: {
                        readonly type: "boolean";
                    };
                    readonly user_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly organization_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly DeviceCodeRequest: {
                readonly type: "object";
                readonly required: readonly ["client_id", "scopes"];
                readonly properties: {
                    readonly client_id: {
                        readonly type: "string";
                        readonly const: "nehemiah-cli";
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly maxItems: 7;
                        readonly uniqueItems: true;
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly DeviceCodeResponse: {
                readonly type: "object";
                readonly required: readonly ["device_code", "user_code", "verification_uri", "verification_uri_complete", "expires_in", "interval", "scopes"];
                readonly properties: {
                    readonly device_code: {
                        readonly type: "string";
                        readonly pattern: "^bc_device_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$";
                        readonly readOnly: true;
                    };
                    readonly user_code: {
                        readonly type: "string";
                        readonly pattern: "^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$";
                    };
                    readonly verification_uri: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly verification_uri_complete: {
                        readonly type: "string";
                        readonly format: "uri";
                        readonly description: "Contains only the non-secret human user_code query parameter.";
                    };
                    readonly expires_in: {
                        readonly type: "integer";
                        readonly minimum: 60;
                        readonly maximum: 600;
                    };
                    readonly interval: {
                        readonly type: "integer";
                        readonly minimum: 5;
                        readonly maximum: 60;
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly InspectDeviceCodeRequest: {
                readonly type: "object";
                readonly required: readonly ["user_code"];
                readonly properties: {
                    readonly user_code: {
                        readonly type: "string";
                        readonly pattern: "^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly DeviceAuthorizationRequest: {
                readonly type: "object";
                readonly required: readonly ["client_id", "scopes", "expires_at", "status"];
                readonly properties: {
                    readonly client_id: {
                        readonly type: "string";
                        readonly const: "nehemiah-cli";
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly items: {
                            $ref: string;
                        };
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly const: "pending";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly AuthorizeDeviceRequest: {
                readonly type: "object";
                readonly required: readonly ["user_code", "decision"];
                readonly properties: {
                    readonly user_code: {
                        readonly type: "string";
                        readonly pattern: "^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$";
                    };
                    readonly decision: {
                        readonly type: "string";
                        readonly enum: readonly ["approve", "deny"];
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly maxItems: 7;
                        readonly uniqueItems: true;
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly DeviceAuthorizationDecision: {
                readonly type: "object";
                readonly required: readonly ["decision", "authorized", "denied"];
                readonly properties: {
                    readonly decision: {
                        readonly type: "string";
                        readonly enum: readonly ["approve", "deny"];
                    };
                    readonly authorized: {
                        readonly type: "boolean";
                    };
                    readonly denied: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ExchangeDeviceCodeRequest: {
                readonly type: "object";
                readonly required: readonly ["device_code"];
                readonly properties: {
                    readonly device_code: {
                        readonly type: "string";
                        readonly pattern: "^bc_device_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$";
                        readonly writeOnly: true;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly RefreshDeviceTokenRequest: {
                readonly type: "object";
                readonly required: readonly ["refresh_token"];
                readonly properties: {
                    readonly refresh_token: {
                        readonly type: "string";
                        readonly pattern: "^bc_refresh_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$";
                        readonly writeOnly: true;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly DeviceTokenResponse: {
                readonly type: "object";
                readonly required: readonly ["token_type", "access_token", "expires_in", "refresh_token", "refresh_expires_in", "organization_id", "project_id", "scopes"];
                readonly properties: {
                    readonly token_type: {
                        readonly type: "string";
                        readonly const: "Bearer";
                    };
                    readonly access_token: {
                        readonly type: "string";
                        readonly pattern: "^bc_access_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$";
                        readonly readOnly: true;
                    };
                    readonly expires_in: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 900;
                    };
                    readonly refresh_token: {
                        readonly type: "string";
                        readonly pattern: "^bc_refresh_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$";
                        readonly readOnly: true;
                    };
                    readonly refresh_expires_in: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 2592000;
                    };
                    readonly organization_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly MachineState: {
                readonly type: "string";
                readonly enum: readonly ["requested", "placing", "starting", "running", "stopping", "stopped", "failed", "lost"];
            };
            readonly Architecture: {
                readonly type: "string";
                readonly enum: readonly ["x86_64", "aarch64"];
            };
            readonly RuntimeCohort: {
                readonly type: "object";
                readonly required: readonly ["id", "contract_version", "arch", "kernel_sha256", "firecracker_sha256", "jailer_sha256", "python_rootfs_sha256", "desktop_rootfs_sha256"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                    readonly contract_version: {
                        readonly type: "integer";
                        readonly const: 4;
                    };
                    readonly arch: {
                        readonly type: "string";
                        readonly enum: readonly ["amd64", "arm64"];
                    };
                    readonly kernel_sha256: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                    readonly firecracker_sha256: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                    readonly jailer_sha256: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                    readonly python_rootfs_sha256: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                    readonly desktop_rootfs_sha256: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                };
                readonly additionalProperties: false;
                readonly description: "Exact signed managed-host runtime cohort. id is SHA-256 of the canonical contract-version, architecture, built-in rootfs, kernel, Firecracker, and jailer digest lines.";
            };
            readonly MachineResources: {
                readonly type: "object";
                readonly required: readonly ["vcpus", "memory_mb", "disk_mb"];
                readonly properties: {
                    readonly vcpus: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 4;
                    };
                    readonly memory_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 4096;
                    };
                    readonly disk_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 20480;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly NetworkPolicy: {
                readonly type: "object";
                readonly required: readonly ["mode", "hostnames", "cidrs"];
                readonly properties: {
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "allowlist"];
                    };
                    readonly hostnames: {
                        readonly type: "array";
                        readonly maxItems: 64;
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly cidrs: {
                        readonly type: "array";
                        readonly maxItems: 64;
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly NetworkPolicyDeclaration: {
                readonly type: "object";
                readonly required: readonly ["mode"];
                readonly description: "Managed beta is fail-closed to mode=off until aggregate organization, project, and host-network traffic quotas exist.";
                readonly properties: {
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["off"];
                    };
                    readonly hostnames: {
                        readonly type: "array";
                        readonly maxItems: 0;
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly cidrs: {
                        readonly type: "array";
                        readonly maxItems: 0;
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly Machine: {
                readonly type: "object";
                readonly required: readonly ["id", "project_id", "state", "status", "ready", "region", "architecture", "resources", "network_policy", "created_at", "expires_at"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly state: {
                        $ref: string;
                    };
                    readonly status: {
                        $ref: string;
                    };
                    readonly ready: {
                        readonly type: "boolean";
                    };
                    readonly region: {
                        readonly type: "string";
                    };
                    readonly architecture: {
                        $ref: string;
                    };
                    readonly runtime_cohort_id: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                    readonly source_sha256: {
                        readonly type: "string";
                        readonly pattern: "^[0-9a-f]{64}$";
                    };
                    readonly resources: {
                        $ref: string;
                    };
                    readonly template: {
                        readonly type: "string";
                    };
                    readonly template_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly oci_reference: {
                        readonly type: "string";
                    };
                    readonly network_policy: {
                        $ref: string;
                    };
                    readonly parent_id: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                    readonly created_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly started_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly ready_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly stopped_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly failure_reason: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly MachineList: {
                readonly type: "object";
                readonly required: readonly ["machines"];
                readonly properties: {
                    readonly machines: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                    readonly next_cursor: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly CreateMachineRequest: {
                readonly type: "object";
                readonly oneOf: readonly [{
                    readonly required: readonly ["template"];
                }, {
                    readonly required: readonly ["template_id"];
                }, {
                    readonly required: readonly ["oci_reference"];
                }];
                readonly properties: {
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly region: {
                        readonly type: "string";
                    };
                    readonly architecture: {
                        $ref: string;
                    };
                    readonly template: {
                        readonly type: "string";
                        readonly enum: readonly ["python", "desktop"];
                    };
                    readonly template_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly oci_reference: {
                        readonly type: "string";
                        readonly deprecated: true;
                        readonly description: "Reserved field. Managed OCI imports return typed 501 not_supported.";
                    };
                    readonly ttl_seconds: {
                        readonly type: "integer";
                        readonly minimum: 15;
                        readonly maximum: 86400;
                    };
                    readonly vcpus: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 4;
                    };
                    readonly memory_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 4096;
                    };
                    readonly disk_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 20480;
                    };
                    readonly network_policy: {
                        $ref: string;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ExtendMachineRequest: {
                readonly type: "object";
                readonly properties: {
                    readonly ttl_seconds: {
                        readonly type: "integer";
                        readonly minimum: 15;
                        readonly maximum: 86400;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ForkMachineRequest: {
                readonly type: "object";
                readonly properties: {
                    readonly count: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 8;
                        readonly default: 1;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly MachineBatch: {
                readonly type: "object";
                readonly required: readonly ["machines", "requested"];
                readonly properties: {
                    readonly machines: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                    readonly requested: {
                        readonly type: "integer";
                        readonly minimum: 2;
                        readonly maximum: 8;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly PendingForkOperation: {
                readonly type: "object";
                readonly required: readonly ["id", "state", "idempotency_key", "source_machine_id", "requested"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly state: {
                        readonly type: "string";
                        readonly enum: readonly ["pending", "cleanup_pending"];
                    };
                    readonly idempotency_key: {
                        readonly type: "string";
                        readonly pattern: "^[A-Za-z0-9._:-]{1,128}$";
                    };
                    readonly source_machine_id: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                    readonly requested: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 8;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly PendingForkResponse: {
                readonly type: "object";
                readonly required: readonly ["operation", "machines", "requested"];
                readonly properties: {
                    readonly operation: {
                        $ref: string;
                    };
                    readonly machines: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                    readonly requested: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 8;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ExecMachineRequest: {
                readonly type: "object";
                readonly required: readonly ["command"];
                readonly properties: {
                    readonly command: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 65536;
                    };
                    readonly timeout_seconds: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 120;
                        readonly default: 30;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ExecResult: {
                readonly type: "object";
                readonly required: readonly ["exit_code", "timed_out", "duration_ms"];
                readonly properties: {
                    readonly output: {
                        readonly type: "string";
                    };
                    readonly stdout: {
                        readonly type: "string";
                    };
                    readonly stderr: {
                        readonly type: "string";
                    };
                    readonly exit_code: {
                        readonly type: readonly ["integer", "null"];
                    };
                    readonly timed_out: {
                        readonly type: "boolean";
                    };
                    readonly duration_ms: {
                        readonly type: "integer";
                        readonly minimum: 0;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly GatewayCapability: {
                readonly type: "string";
                readonly enum: readonly ["tty", "vnc", "agent", "files", "preview"];
                readonly description: "Gateway capability. The agent value is reserved for local/self-hosted compatibility and receives typed 501 not_supported from managed session issuance.";
            };
            readonly CreateMachineSessionRequest: {
                readonly type: "object";
                readonly properties: {
                    readonly capabilities: {
                        readonly type: "array";
                        readonly minItems: 1;
                        readonly uniqueItems: true;
                        readonly items: {
                            $ref: string;
                        };
                    };
                    readonly port: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 65535;
                    };
                    readonly ttl_seconds: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 900;
                        readonly default: 300;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly MachineSession: {
                readonly type: "object";
                readonly required: readonly ["id", "token", "expires_in", "gateway_url"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                        readonly readOnly: true;
                    };
                    readonly token: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 4096;
                        readonly readOnly: true;
                    };
                    readonly expires_in: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 900;
                    };
                    readonly gateway_url: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly preview_url: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly FileUploadResult: {
                readonly type: "object";
                readonly required: readonly ["ok", "path", "bytes", "transport"];
                readonly properties: {
                    readonly ok: {
                        readonly type: "boolean";
                        readonly const: true;
                    };
                    readonly path: {
                        readonly type: "string";
                        readonly pattern: "^/root/[A-Za-z0-9._-]+$";
                    };
                    readonly bytes: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 16777216;
                    };
                    readonly transport: {
                        readonly type: "string";
                        readonly const: "vsock";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly TemplateSource: {
                readonly type: "object";
                readonly required: readonly ["machine_id"];
                readonly properties: {
                    readonly machine_id: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly TemplateArtifact: {
                readonly type: "object";
                readonly required: readonly ["object_key", "checksum", "size_bytes"];
                readonly properties: {
                    readonly object_key: {
                        readonly type: "string";
                    };
                    readonly checksum: {
                        readonly type: "string";
                        readonly pattern: "^sha256:[0-9a-f]{64}$";
                    };
                    readonly size_bytes: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 5368709120;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ManagedTemplateManifest: {
                readonly type: "object";
                readonly required: readonly ["schema_version", "format", "architecture", "source", "artifact"];
                readonly properties: {
                    readonly schema_version: {
                        readonly type: "integer";
                        readonly const: 1;
                    };
                    readonly format: {
                        readonly type: "string";
                        readonly const: "firecracker-snapshot-v1";
                    };
                    readonly architecture: {
                        $ref: string;
                    };
                    readonly source: {
                        $ref: string;
                    };
                    readonly artifact: {
                        $ref: string;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ManagedTemplate: {
                readonly type: "object";
                readonly required: readonly ["id", "project_id", "name", "version", "manifest", "checksum", "size_bytes", "source_machine_id", "created_at"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly name: {
                        readonly type: "string";
                        readonly pattern: "^[a-z0-9][a-z0-9._-]{0,62}$";
                    };
                    readonly version: {
                        readonly type: "string";
                        readonly pattern: "^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$";
                    };
                    readonly manifest: {
                        $ref: string;
                    };
                    readonly checksum: {
                        readonly type: "string";
                        readonly pattern: "^sha256:[0-9a-f]{64}$";
                    };
                    readonly size_bytes: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 5368709120;
                    };
                    readonly source_machine_id: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                    readonly created_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ManagedTemplateList: {
                readonly type: "object";
                readonly required: readonly ["templates"];
                readonly properties: {
                    readonly templates: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly PublishTemplateRequest: {
                readonly type: "object";
                readonly required: readonly ["machine_id", "name", "version"];
                readonly properties: {
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly machine_id: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                    readonly name: {
                        readonly type: "string";
                        readonly pattern: "^[a-z0-9][a-z0-9._-]{0,62}$";
                    };
                    readonly version: {
                        readonly type: "string";
                        readonly pattern: "^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly Volume: {
                readonly type: "object";
                readonly required: readonly ["id", "project_id", "created_at", "expires_at", "quota_mb", "used_bytes"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly pattern: "^vol_[A-Za-z0-9_-]{22}$";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly created_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly quota_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 1048576;
                    };
                    readonly used_bytes: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 1099511627776;
                    };
                    readonly deleted_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly delete_after: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly VolumeGrant: {
                readonly type: "object";
                readonly required: readonly ["method", "url", "headers", "expires_at"];
                readonly properties: {
                    readonly method: {
                        readonly type: "string";
                        readonly enum: readonly ["GET", "PUT"];
                    };
                    readonly url: {
                        readonly type: "string";
                        readonly format: "uri-reference";
                    };
                    readonly headers: {
                        readonly type: "object";
                        readonly additionalProperties: {
                            readonly type: "string";
                        };
                        readonly maxProperties: 16;
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly maximum_bytes: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 1099511627776;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly VolumeWithGrant: {
                readonly type: "object";
                readonly required: readonly ["id", "project_id", "created_at", "expires_at", "quota_mb", "used_bytes", "grant"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly pattern: "^vol_[A-Za-z0-9_-]{22}$";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly created_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly quota_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 1048576;
                    };
                    readonly used_bytes: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 1099511627776;
                    };
                    readonly grant: {
                        $ref: string;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly VolumeList: {
                readonly type: "object";
                readonly required: readonly ["volumes"];
                readonly properties: {
                    readonly volumes: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly CreateVolumeRequest: {
                readonly type: "object";
                readonly properties: {
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly size_limit_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 1048576;
                    };
                    readonly ttl_seconds: {
                        readonly type: "integer";
                        readonly minimum: 3600;
                        readonly maximum: 31536000;
                    };
                    readonly grant_ttl_seconds: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 900;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly CreateVolumeGrantRequest: {
                readonly type: "object";
                readonly required: readonly ["method"];
                readonly properties: {
                    readonly method: {
                        readonly type: "string";
                        readonly enum: readonly ["GET", "PUT"];
                    };
                    readonly ttl_seconds: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 900;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly VolumeGrantResponse: {
                readonly type: "object";
                readonly required: readonly ["volume", "grant"];
                readonly properties: {
                    readonly volume: {
                        $ref: string;
                    };
                    readonly grant: {
                        $ref: string;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly CreateHostEnrollmentRequest: {
                readonly type: "object";
                readonly required: readonly ["provider_id", "region_id", "address", "architecture", "total_vcpus", "total_memory_mb", "total_disk_mb", "runtime_cohort"];
                readonly properties: {
                    readonly provider_id: {
                        readonly type: "string";
                        readonly pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
                    };
                    readonly region_id: {
                        readonly type: "string";
                        readonly pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
                    };
                    readonly address: {
                        readonly type: "string";
                        readonly description: "Literal address in the configured managed-host overlay.";
                    };
                    readonly architecture: {
                        readonly type: "string";
                        readonly enum: readonly ["x86_64", "aarch64"];
                    };
                    readonly total_vcpus: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 4096;
                    };
                    readonly total_memory_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 16777216;
                    };
                    readonly total_disk_mb: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 9007199254740991;
                    };
                    readonly ttl_seconds: {
                        readonly type: "integer";
                        readonly minimum: 60;
                        readonly maximum: 1800;
                        readonly default: 600;
                    };
                    readonly runtime_cohort: {
                        $ref: string;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly HostEnrollmentResponse: {
                readonly type: "object";
                readonly required: readonly ["id", "host_id", "token", "expires_at", "secret_displayed_once"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly host_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly token: {
                        readonly type: "string";
                        readonly pattern: "^nhe_[A-Za-z0-9_-]{43}$";
                        readonly readOnly: true;
                        readonly description: "256-bit one-use host enrollment grant. Store only in the private per-host provisioning input.";
                    };
                    readonly expires_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly secret_displayed_once: {
                        readonly type: "boolean";
                        readonly const: true;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly HostLifecycle: {
                readonly type: "object";
                readonly required: readonly ["id", "desired_state", "credential_generation", "credential_status", "credential_rotated_at"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly desired_state: {
                        readonly type: "string";
                        readonly enum: readonly ["active", "draining", "quarantined", "revoked"];
                    };
                    readonly credential_generation: {
                        readonly type: "integer";
                        readonly minimum: 1;
                    };
                    readonly credential_status: {
                        readonly type: "string";
                        readonly enum: readonly ["active", "revoked"];
                    };
                    readonly credential_rotated_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly credential_revoked_at: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly lifecycle_reason: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 512;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly HostLifecycleRequest: {
                readonly type: "object";
                readonly properties: {
                    readonly reason: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 512;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly HostLifecycleResponse: {
                readonly type: "object";
                readonly required: readonly ["host"];
                readonly properties: {
                    readonly host: {
                        $ref: string;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly RotateHostCredentialsRequest: {
                readonly type: "object";
                readonly required: readonly ["control_token", "gateway_token"];
                readonly properties: {
                    readonly control_token: {
                        readonly type: "string";
                        readonly minLength: 32;
                        readonly description: "Must differ from gateway_token.";
                    };
                    readonly gateway_token: {
                        readonly type: "string";
                        readonly minLength: 32;
                        readonly description: "Must differ from control_token.";
                    };
                    readonly reason: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 512;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly RotateHostCredentialsResponse: {
                readonly type: "object";
                readonly required: readonly ["host", "credential", "secret_displayed_once"];
                readonly properties: {
                    readonly host: {
                        $ref: string;
                    };
                    readonly credential: {
                        readonly type: "string";
                        readonly pattern: "^nh_[0-9a-f]{64}$";
                        readonly readOnly: true;
                    };
                    readonly secret_displayed_once: {
                        readonly type: "boolean";
                        readonly const: true;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly BillingAccount: {
                readonly type: "object";
                readonly required: readonly ["plan"];
                readonly properties: {
                    readonly plan: {
                        readonly type: "string";
                    };
                    readonly spend_cap_cents: {
                        readonly type: readonly ["integer", "null"];
                        readonly minimum: 0;
                    };
                    readonly delinquent_at: {
                        readonly type: readonly ["string", "null"];
                        readonly format: "date-time";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly UsageDimension: {
                readonly type: "string";
                readonly enum: readonly ["vcpu_seconds", "gib_seconds", "storage_gib_hours", "egress_bytes", "inference_units"];
            };
            readonly UsageRecord: {
                readonly type: "object";
                readonly required: readonly ["usage_date", "project_id", "dimension", "quantity"];
                readonly properties: {
                    readonly usage_date: {
                        readonly type: "string";
                        readonly format: "date";
                    };
                    readonly project_id: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly dimension: {
                        $ref: string;
                    };
                    readonly quantity: {
                        readonly type: "string";
                        readonly pattern: "^[0-9]+(?:\\.[0-9]+)?$";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly UsageResponse: {
                readonly type: "object";
                readonly required: readonly ["account", "usage"];
                readonly properties: {
                    readonly account: {
                        $ref: string;
                    };
                    readonly usage: {
                        readonly type: "array";
                        readonly items: {
                            $ref: string;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly StripeWebhookResponse: {
                readonly type: "object";
                readonly required: readonly ["received", "replayed"];
                readonly properties: {
                    readonly received: {
                        readonly type: "boolean";
                        readonly const: true;
                    };
                    readonly replayed: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
        };
    };
    readonly security: readonly [{
        readonly bearerAuth: readonly [];
    }];
    readonly paths: {
        readonly '/v1/auth/device/code': {
            readonly post: {
                readonly operationId: "issueDeviceCode";
                readonly security: readonly [];
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/auth/device/inspect': {
            readonly post: {
                readonly operationId: "inspectDeviceAuthorization";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/auth/device/authorize': {
            readonly post: {
                readonly operationId: "authorizeDevice";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/auth/device/token': {
            readonly post: {
                readonly operationId: "exchangeDeviceCode";
                readonly security: readonly [];
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/auth/device/refresh': {
            readonly post: {
                readonly operationId: "refreshDeviceCredential";
                readonly security: readonly [];
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/auth/device/revoke': {
            readonly post: {
                readonly operationId: "revokeDeviceCredential";
                readonly security: readonly [];
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '204': {
                        readonly description: "Refresh family and active access tokens revoked idempotently";
                    };
                };
            };
        };
        readonly '/v1/organizations': {
            readonly get: {
                readonly operationId: "listOrganizations";
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/projects': {
            readonly get: {
                readonly operationId: "listProjects";
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly operationId: "createProject";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/api-keys': {
            readonly get: {
                readonly operationId: "listApiKeys";
                readonly parameters: readonly [{
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        format: string;
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly operationId: "createApiKey";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/api-keys/{id}': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly delete: {
                readonly operationId: "revokeApiKey";
                readonly responses: {
                    readonly '204': {
                        readonly description: "API key revoked; repeated revocation remains successful";
                    };
                };
            };
        };
        readonly '/v1/api-keys/{id}/disable': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "disableApiKey";
                readonly responses: {
                    readonly '204': {
                        readonly description: "API key disabled and its outstanding grants revoked";
                    };
                };
            };
        };
        readonly '/v1/api-keys/{id}/enable': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "enableApiKey";
                readonly responses: {
                    readonly '204': {
                        readonly description: "API key enabled; previously revoked grants remain revoked";
                    };
                };
            };
        };
        readonly '/v1/api-keys/{id}/rotate': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "rotateApiKey";
                readonly responses: {
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/identity-provider/sync': {
            readonly post: {
                readonly operationId: "syncIdentityProviderLifecycle";
                readonly description: "Explicit fleet-operator Clerk lifecycle synchronization. Events map only to existing immutable local subjects and explicit local organization UUIDs; raw provider payloads and credentials are never retained.";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/users/{id}/disable': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "disableUserIdentity";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/users/{id}/enable': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "enableUserIdentity";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/organizations/{id}/disable': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "disableOrganizationIdentity";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/organizations/{id}/enable': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "enableOrganizationIdentity";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/machines': {
            readonly get: {
                readonly operationId: "listMachines";
                readonly parameters: readonly [{
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        format: string;
                    };
                }, {
                    readonly name: "cursor";
                    readonly in: "query";
                    readonly required: false;
                    readonly schema: {
                        readonly type: "string";
                        readonly pattern: "^m_[A-Za-z0-9_-]{1,126}$";
                    };
                }, {
                    readonly name: "limit";
                    readonly in: "query";
                    readonly required: false;
                    readonly schema: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 100;
                        readonly default: 50;
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly operationId: "createMachine";
                readonly parameters: readonly [{
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        pattern: string;
                    };
                }];
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly '202': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/machines/{id}': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly get: {
                readonly operationId: "getMachine";
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly delete: {
                readonly operationId: "destroyMachine";
                readonly responses: {
                    readonly '204': {
                        readonly description: "Machine stopped";
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/extend': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }, {
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "extendMachine";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/fork': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }, {
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "forkMachine";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        readonly description: "Durable single or batch fork result replayed";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly oneOf: readonly [{
                                        $ref: string;
                                    }, {
                                        $ref: string;
                                    }];
                                };
                            };
                        };
                    };
                    readonly '201': {
                        readonly description: "Single or complete batch fork created";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly oneOf: readonly [{
                                        $ref: string;
                                    }, {
                                        $ref: string;
                                    }];
                                };
                            };
                        };
                    };
                    readonly '202': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/exec': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "execMachine";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/sessions': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "createMachineSession";
                readonly description: "Issues a revocable managed gateway session. The host-local agent capability is deliberately unsupported and returns typed 501 before grant persistence.";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/sessions/{sessionId}': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }, {
                readonly name: "sessionId";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly format: "uuid";
                };
            }];
            readonly delete: {
                readonly operationId: "revokeMachineSession";
                readonly responses: {
                    readonly '204': {
                        readonly description: "Machine session revoked or already revoked";
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/upload': {
            readonly servers: readonly [{
                readonly url: "https://gateway.boringcomputers.com";
            }];
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "uploadMachineFile";
                readonly security: readonly [{
                    readonly machineCapability: readonly [];
                }];
                readonly parameters: readonly [{
                    readonly name: "X-Filename";
                    readonly in: "header";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly pattern: "^[A-Za-z0-9._-]{1,255}$";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/octet-stream': {
                            readonly schema: {
                                readonly type: "string";
                                readonly format: "binary";
                                readonly maxLength: 16777216;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/download': {
            readonly servers: readonly [{
                readonly url: "https://gateway.boringcomputers.com";
            }];
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly get: {
                readonly operationId: "downloadMachineFile";
                readonly security: readonly [{
                    readonly machineCapability: readonly [];
                }];
                readonly parameters: readonly [{
                    readonly name: "path";
                    readonly in: "query";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly pattern: "^/(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        readonly description: "Bounded guest file bytes";
                        readonly content: {
                            readonly 'application/octet-stream': {
                                readonly schema: {
                                    readonly type: "string";
                                    readonly format: "binary";
                                    readonly maxLength: 16777216;
                                };
                            };
                        };
                    };
                };
            };
            readonly head: {
                readonly operationId: "inspectMachineFile";
                readonly security: readonly [{
                    readonly machineCapability: readonly [];
                }];
                readonly parameters: readonly [{
                    readonly name: "path";
                    readonly in: "query";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly pattern: "^/(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        readonly description: "Bounded guest file metadata";
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/tty': {
            readonly servers: readonly [{
                readonly url: "wss://gateway.boringcomputers.com";
            }];
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly get: {
                readonly operationId: "connectMachineTty";
                readonly security: readonly [{
                    readonly websocketCapability: readonly [];
                }];
                readonly parameters: ({
                    name: string;
                    in: string;
                    required: boolean;
                    description: string;
                    schema: {
                        type: string;
                        maxLength: number;
                        const?: undefined;
                    };
                } | {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                        maxLength?: undefined;
                    };
                    description?: undefined;
                })[];
                readonly responses: {
                    readonly '101': {
                        description: string;
                        headers: {
                            Connection: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                            Upgrade: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                        };
                    };
                };
                readonly 'x-nehemiah-websocket': {
                    payload_modeling: string;
                    initial_client_frame?: Readonly<Record<string, unknown>> | undefined;
                    capability: "tty" | "vnc" | "agent";
                    required_subprotocol_prefix: string;
                    query_credentials_allowed: boolean;
                    client_frame_types: readonly ("binary" | "text")[];
                    server_frame_types: readonly ("binary" | "text")[];
                    max_client_frame_bytes: number;
                    idle: {
                        timeout_seconds: number;
                        behavior: string;
                    };
                    lifetime: {
                        maximum_seconds: number;
                        behavior: string;
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/vnc': {
            readonly servers: readonly [{
                readonly url: "wss://gateway.boringcomputers.com";
            }];
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly get: {
                readonly operationId: "connectMachineVnc";
                readonly security: readonly [{
                    readonly websocketCapability: readonly [];
                }];
                readonly parameters: ({
                    name: string;
                    in: string;
                    required: boolean;
                    description: string;
                    schema: {
                        type: string;
                        maxLength: number;
                        const?: undefined;
                    };
                } | {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                        maxLength?: undefined;
                    };
                    description?: undefined;
                })[];
                readonly responses: {
                    readonly '101': {
                        description: string;
                        headers: {
                            Connection: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                            Upgrade: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                        };
                    };
                };
                readonly 'x-nehemiah-websocket': {
                    payload_modeling: string;
                    initial_client_frame?: Readonly<Record<string, unknown>> | undefined;
                    capability: "tty" | "vnc" | "agent";
                    required_subprotocol_prefix: string;
                    query_credentials_allowed: boolean;
                    client_frame_types: readonly ("binary" | "text")[];
                    server_frame_types: readonly ("binary" | "text")[];
                    max_client_frame_bytes: number;
                    idle: {
                        timeout_seconds: number;
                        behavior: string;
                    };
                    lifetime: {
                        maximum_seconds: number;
                        behavior: string;
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/agent': {
            readonly servers: readonly [{
                readonly url: "wss://gateway.boringcomputers.com";
            }];
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly get: {
                readonly operationId: "connectMachineDesktopAgent";
                readonly deprecated: true;
                readonly description: "Local/self-hosted compatibility route only. Managed cloud does not issue the required agent capability or distribute a provider model credential.";
                readonly security: readonly [{
                    readonly websocketCapability: readonly [];
                }];
                readonly parameters: ({
                    name: string;
                    in: string;
                    required: boolean;
                    description: string;
                    schema: {
                        type: string;
                        maxLength: number;
                        const?: undefined;
                    };
                } | {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                        maxLength?: undefined;
                    };
                    description?: undefined;
                })[];
                readonly responses: {
                    readonly '101': {
                        description: string;
                        headers: {
                            Connection: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                            Upgrade: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                        };
                    };
                };
                readonly 'x-nehemiah-websocket': {
                    payload_modeling: string;
                    initial_client_frame?: Readonly<Record<string, unknown>> | undefined;
                    capability: "tty" | "vnc" | "agent";
                    required_subprotocol_prefix: string;
                    query_credentials_allowed: boolean;
                    client_frame_types: readonly ("binary" | "text")[];
                    server_frame_types: readonly ("binary" | "text")[];
                    max_client_frame_bytes: number;
                    idle: {
                        timeout_seconds: number;
                        behavior: string;
                    };
                    lifetime: {
                        maximum_seconds: number;
                        behavior: string;
                    };
                };
            };
        };
        readonly '/v1/machines/{id}/shell-agent': {
            readonly servers: readonly [{
                readonly url: "wss://gateway.boringcomputers.com";
            }];
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly get: {
                readonly operationId: "connectMachineShellAgent";
                readonly deprecated: true;
                readonly description: "Local/self-hosted compatibility route only. Managed cloud does not issue the required agent capability or distribute a provider model credential.";
                readonly security: readonly [{
                    readonly websocketCapability: readonly [];
                }];
                readonly parameters: readonly [...({
                    name: string;
                    in: string;
                    required: boolean;
                    description: string;
                    schema: {
                        type: string;
                        maxLength: number;
                        const?: undefined;
                    };
                } | {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                        maxLength?: undefined;
                    };
                    description?: undefined;
                })[], {
                    readonly name: "goal";
                    readonly in: "query";
                    readonly required: false;
                    readonly deprecated: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 400;
                    };
                    readonly description: "Legacy local/self-hosted compatibility only. Managed clients MUST omit this query and send the start frame after upgrade.";
                }];
                readonly responses: {
                    readonly '101': {
                        description: string;
                        headers: {
                            Connection: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                            Upgrade: {
                                schema: {
                                    type: string;
                                    const: string;
                                };
                            };
                        };
                    };
                };
                readonly 'x-nehemiah-websocket': {
                    payload_modeling: string;
                    initial_client_frame?: Readonly<Record<string, unknown>> | undefined;
                    capability: "tty" | "vnc" | "agent";
                    required_subprotocol_prefix: string;
                    query_credentials_allowed: boolean;
                    client_frame_types: readonly ("binary" | "text")[];
                    server_frame_types: readonly ("binary" | "text")[];
                    max_client_frame_bytes: number;
                    idle: {
                        timeout_seconds: number;
                        behavior: string;
                    };
                    lifetime: {
                        maximum_seconds: number;
                        behavior: string;
                    };
                };
            };
        };
        readonly '/v1/capability/exchange': {
            readonly servers: readonly [{
                readonly url: "https://gateway.boringcomputers.com";
            }];
            readonly post: {
                readonly operationId: "exchangePreviewCapability";
                readonly security: readonly [{
                    readonly machineCapability: readonly [];
                }];
                readonly responses: {
                    readonly '204': {
                        readonly description: "Preview capability exchanged for a scoped HttpOnly cookie";
                        readonly headers: {
                            readonly 'Set-Cookie': {
                                readonly description: "Short-lived Secure, SameSite=Strict preview cookie scoped to the isolated preview origin";
                                readonly schema: {
                                    readonly type: "string";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/templates': {
            readonly get: {
                readonly operationId: "listManagedTemplates";
                readonly parameters: readonly [{
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        format: string;
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly operationId: "publishManagedTemplate";
                readonly deprecated: true;
                readonly description: "Managed custom-template publication is disabled in production until aggregate tenant/host-cache quotas and durable eviction are enforced. Production returns 503 without exporting or persisting a template.";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/templates/{id}': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }, {
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    format: string;
                };
            }];
            readonly delete: {
                readonly operationId: "deleteManagedTemplate";
                readonly responses: {
                    readonly '204': {
                        readonly description: "Template version retired";
                    };
                };
            };
        };
        readonly '/v1/volumes': {
            readonly get: {
                readonly operationId: "listVolumes";
                readonly deprecated: true;
                readonly description: "Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.";
                readonly parameters: readonly [{
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        format: string;
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly operationId: "createVolume";
                readonly deprecated: true;
                readonly description: "Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.";
                readonly parameters: readonly [{
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        pattern: string;
                    };
                }];
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/volumes/{id}': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly get: {
                readonly operationId: "getVolume";
                readonly deprecated: true;
                readonly description: "Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.";
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly delete: {
                readonly operationId: "deleteVolume";
                readonly deprecated: true;
                readonly description: "Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.";
                readonly responses: {
                    readonly '204': {
                        readonly description: "Soft-deleted with retained object cleanup scheduled";
                        readonly headers: {
                            readonly 'x-volume-delete-after': {
                                readonly description: "Durable retention boundary";
                                readonly schema: {
                                    readonly type: "string";
                                    readonly format: "date-time";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/volumes/{id}/grants': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "createVolumeGrant";
                readonly deprecated: true;
                readonly description: "Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/volume-objects/{capabilityId}': {
            readonly parameters: readonly [{
                readonly name: "capabilityId";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                    readonly pattern: "^[A-Za-z0-9_-]{43}$";
                };
            }];
            readonly get: {
                readonly operationId: "downloadVolumeRevision";
                readonly deprecated: true;
                readonly description: "Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.";
                readonly security: readonly [{
                    readonly volumeCapability: readonly [];
                }];
                readonly responses: {
                    readonly '200': {
                        readonly description: "Latest checksum-verified immutable volume revision";
                        readonly content: {
                            readonly 'application/octet-stream': {
                                readonly schema: {
                                    readonly type: "string";
                                    readonly format: "binary";
                                };
                            };
                        };
                    };
                };
            };
            readonly put: {
                readonly operationId: "uploadVolumeRevision";
                readonly deprecated: true;
                readonly description: "Managed volume and object transfer operations are production-disabled until bounded volume/revision counts and global transfer quotas are enforced. Production returns typed 503 without reading, reserving, or writing volume data.";
                readonly security: readonly [{
                    readonly volumeCapability: readonly [];
                }];
                readonly parameters: readonly [{
                    readonly name: "x-nehemiah-content-sha256";
                    readonly in: "header";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly pattern: "^sha256:[0-9a-f]{64}$";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/octet-stream': {
                            readonly schema: {
                                readonly type: "string";
                                readonly format: "binary";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '201': {
                        readonly description: "Immutable encrypted revision stored and checksum verified";
                    };
                    readonly '204': {
                        readonly description: "Byte-identical reservation replay";
                    };
                };
            };
        };
        readonly '/v1/operator/host-enrollments': {
            readonly post: {
                readonly operationId: "issueHostEnrollment";
                readonly description: "Fleet-operator-only issuance of a short-lived, one-use grant bound to one provider identity, overlay address, architecture, and capacity.";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '201': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/host-enrollments/{id}/revoke': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "revokeHostEnrollment";
                readonly description: "Fleet-operator-only revocation of an unconsumed enrollment grant.";
                readonly responses: {
                    readonly '204': {
                        readonly description: "Enrollment grant revoked";
                    };
                };
            };
        };
        readonly '/v1/operator/hosts/{id}/drain': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "drainHost";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/hosts/{id}/activate': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "activateHost";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/hosts/{id}/quarantine': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "quarantineHost";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/hosts/{id}/revoke': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "revokeHost";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/operator/hosts/{id}/credentials/rotate': {
            readonly parameters: readonly [{
                name: string;
                in: string;
                required: boolean;
                schema: {
                    type: string;
                    pattern: string;
                };
            }];
            readonly post: {
                readonly operationId: "rotateHostCredentials";
                readonly requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/billing/usage': {
            readonly get: {
                readonly operationId: "getBillingUsage";
                readonly parameters: readonly [{
                    readonly name: "from";
                    readonly in: "query";
                    readonly required: false;
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                }, {
                    readonly name: "to";
                    readonly in: "query";
                    readonly required: false;
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                }, {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        format: string;
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/stripe': {
            readonly post: {
                readonly operationId: "receiveStripeWebhook";
                readonly security: readonly [];
                readonly parameters: readonly [{
                    readonly name: "stripe-signature";
                    readonly in: "header";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
    };
};
export declare const openapi: Handler;
