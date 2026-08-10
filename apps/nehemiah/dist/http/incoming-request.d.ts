import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const maximumControlPlaneBodyBytes = 1048576;
export declare const maximumPendingRequestBodies = 64;
export declare const maximumPendingBodiesPerClient = 4;
export declare const controlPlaneHttpServerOptions: {
    readonly headersTimeout: 10000;
    readonly requestTimeout: 30000;
    readonly keepAliveTimeout: 5000;
    readonly connectionsCheckingInterval: 1000;
    readonly maxHeaderSize: number;
    readonly requireHostHeader: true;
};
/**
 * Bounds requests that have reached Node but have not finished supplying their
 * bodies. Entries exist only while active and total cardinality is bounded by
 * the global ceiling. Admission is non-queued so slow senders cannot accumulate
 * promises, buffers, or database work behind this boundary.
 */
export declare class PendingRequestBodyAdmission {
    #private;
    constructor(maximumTotal?: number, maximumPerClient?: number);
    tryAcquire(client: string): (() => void) | undefined;
    snapshot(): {
        readonly total: number;
        readonly clients: number;
    };
}
export interface PendingRequestBodyLease {
    readonly headers: Headers;
    readonly release: () => void;
}
export declare const sanitizedIncomingHeaders: (request: IncomingMessage, gatewayToken: string) => Headers;
export declare const admitPendingRequestBody: (request: IncomingMessage, response: ServerResponse, gatewayToken: string, admission: PendingRequestBodyAdmission) => PendingRequestBodyLease | undefined;
export declare const incomingRequest: (request: IncomingMessage, headers: Headers, maximumBodyBytes?: number) => Promise<Request>;
export declare const rejectPendingRequest: (request: IncomingMessage, response: ServerResponse) => void;
export declare const closeAfterResponse: (request: IncomingMessage, response: ServerResponse) => void;
