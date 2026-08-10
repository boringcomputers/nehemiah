import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
export const clientAddressHeader = 'x-nehemiah-client-address';
export const clientTimestampHeader = 'x-nehemiah-client-timestamp';
export const clientSignatureHeader = 'x-nehemiah-client-signature';
const signaturePayload = (address, timestamp) => `nehemiah-client-address-v1\n${timestamp}\n${address}`;
const canonicalAddress = (raw) => {
    const value = (raw ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
    if (value.includes(',') || isIP(value) === 0)
        return undefined;
    return value.toLowerCase();
};
/**
 * Accept an edge-derived address only when the gateway authenticated it with
 * the private service credential. Untrusted or stale caller headers collapse
 * to the direct TCP peer, so spoofing can only make admission more restrictive.
 */
export const verifiedClientAddress = (headers, directAddress, gatewayToken, now = new Date()) => {
    const direct = canonicalAddress(directAddress) ?? 'unknown';
    const forwarded = canonicalAddress(headers.get(clientAddressHeader) ?? undefined);
    const timestamp = headers.get(clientTimestampHeader)?.trim();
    const signature = headers.get(clientSignatureHeader)?.trim().toLowerCase();
    if (!forwarded || !timestamp || !signature || !/^[0-9]{1,12}$/.test(timestamp))
        return direct;
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds) ||
        Math.abs(Math.floor(now.getTime() / 1_000) - seconds) > 30) {
        return direct;
    }
    if (!/^[a-f0-9]{64}$/.test(signature))
        return direct;
    const expected = createHmac('sha256', gatewayToken)
        .update(signaturePayload(forwarded, timestamp))
        .digest();
    const provided = Buffer.from(signature, 'hex');
    return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected)
        ? forwarded
        : direct;
};
//# sourceMappingURL=client-identity.js.map