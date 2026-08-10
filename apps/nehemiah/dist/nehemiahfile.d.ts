import { type NetworkPolicyDeclaration } from './domain/network-policy.js';
export interface Nehemiahfile {
    readonly version: 1;
    readonly image: {
        readonly template: string;
    } | {
        readonly oci: string;
    };
    readonly resources: {
        readonly vcpus: number;
        readonly memory_mb: number;
        readonly disk_mb: number;
    };
    readonly network: NetworkPolicyDeclaration;
    readonly ports: ReadonlyArray<number>;
    readonly setup: ReadonlyArray<string>;
    readonly persistence?: {
        readonly volume: string;
        readonly mount: string;
    };
    readonly forkable: boolean;
    readonly readiness?: {
        readonly tcp_port?: number;
        readonly http_path?: string;
    };
}
export declare const parseNehemiahfile: (source: string) => Nehemiahfile;
