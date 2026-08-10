export declare const clientAddressHeader = "x-nehemiah-client-address";
export declare const clientTimestampHeader = "x-nehemiah-client-timestamp";
export declare const clientSignatureHeader = "x-nehemiah-client-signature";
/**
 * Accept an edge-derived address only when the gateway authenticated it with
 * the private service credential. Untrusted or stale caller headers collapse
 * to the direct TCP peer, so spoofing can only make admission more restrictive.
 */
export declare const verifiedClientAddress: (headers: Headers, directAddress: string | undefined, gatewayToken: string, now?: Date) => string;
