import type { HostCredentialResolver } from '../domain/host-credentials.js';
import { type TemplatePublisher } from '../domain/templates.js';
import type { TemplateActivator } from '../jobs/replicate-template.js';
export declare const templateObjectOrigins: (input: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly forcePathStyle: boolean;
}) => ReadonlyArray<string>;
/** Private host adapter for the export-first publication and checksum-verified
 * activation contracts. Each call resolves the target host's unique inbound
 * credential; no fleet-wide or object-store master credential is forwarded. */
export declare class NehemiahdTemplateClient implements TemplatePublisher, TemplateActivator {
    #private;
    private readonly credentials;
    private readonly fetcher;
    private readonly requestTimeoutMs;
    private readonly hostPort;
    constructor(credentials: HostCredentialResolver, allowedObjectOrigins: ReadonlyArray<string>, fetcher?: typeof fetch, requestTimeoutMs?: number, hostPort?: number);
    export(input: Parameters<TemplatePublisher['export']>[0]): Promise<{
        exportId: string;
        checksum: string;
        sizeBytes: number;
    }>;
    upload(input: Parameters<TemplatePublisher['upload']>[0]): Promise<{
        checksum: string;
        sizeBytes: number;
    }>;
    discard(input: Parameters<TemplatePublisher['discard']>[0]): Promise<void>;
    activate(input: Parameters<TemplateActivator['activate']>[0]): Promise<{
        checksum: string;
        sizeBytes: number;
    }>;
}
