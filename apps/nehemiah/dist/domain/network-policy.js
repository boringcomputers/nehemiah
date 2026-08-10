import { BlockList, isIP } from 'node:net';
const hardFloorCidrs = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '::/128',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8'
];
const addCidr = (block, cidr) => {
    const [network, prefixText, extra] = cidr.split('/');
    const version = network ? isIP(network) : 0;
    const prefix = Number(prefixText);
    if (!network ||
        extra !== undefined ||
        !Number.isSafeInteger(prefix) ||
        (version === 4 && (prefix < 0 || prefix > 32)) ||
        (version === 6 && (prefix < 0 || prefix > 128)) ||
        version === 0) {
        throw new Error(`invalid IP CIDR: ${cidr}`);
    }
    block.addSubnet(network, prefix, version === 4 ? 'ipv4' : 'ipv6');
};
export const isHardBlockedAddress = (ip, additionalBlockedCidrs = []) => {
    const version = isIP(ip);
    if (version === 0)
        return true;
    const block = new BlockList();
    for (const cidr of [...hardFloorCidrs, ...additionalBlockedCidrs])
        addCidr(block, cidr);
    // Node's IPv6 check also applies matching IPv4 rules to mapped IPv6 forms,
    // including both dotted and hexadecimal spellings.
    return block.check(ip, version === 4 ? 'ipv4' : 'ipv6');
};
const normalizeHostname = (hostname) => hostname.toLowerCase().replace(/\.$/, '');
const validHostnameRule = (hostname) => /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname);
const hostnameMatches = (rule, hostname) => rule.startsWith('*.')
    ? hostname.endsWith(rule.slice(1)) && hostname !== rule.slice(2)
    : hostname === rule;
/**
 * Control-plane representation of strict egress. The host DNS interceptor uses
 * the same decisions: deny by default, clamp DNS TTL, and never learn a hard-floor address.
 */
export class EgressPolicy {
    additionalBlockedCidrs;
    declaration;
    #hostnames;
    #allowedAddresses = new BlockList();
    #learned = new Map();
    constructor(declaration, additionalBlockedCidrs = []) {
        this.additionalBlockedCidrs = additionalBlockedCidrs;
        if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
            throw new Error('network policy must be an object');
        }
        const unknownKeys = Object.keys(declaration).filter((key) => !['mode', 'hostnames', 'cidrs'].includes(key));
        if (unknownKeys.length > 0)
            throw new Error('network policy contains an unknown field');
        if (declaration.mode !== 'off' && declaration.mode !== 'allowlist') {
            throw new Error('network mode must be off or allowlist');
        }
        if ((declaration.hostnames !== undefined &&
            (!Array.isArray(declaration.hostnames) ||
                declaration.hostnames.some((hostname) => typeof hostname !== 'string'))) ||
            (declaration.cidrs !== undefined &&
                (!Array.isArray(declaration.cidrs) ||
                    declaration.cidrs.some((cidr) => typeof cidr !== 'string')))) {
            throw new Error('network hostnames and CIDRs must be string arrays');
        }
        if ((declaration.hostnames?.length ?? 0) > 64 || (declaration.cidrs?.length ?? 0) > 64) {
            throw new Error('network allowlist is limited to 64 hostnames and CIDRs');
        }
        this.#hostnames = [...new Set((declaration.hostnames ?? []).map(normalizeHostname))].sort();
        if (this.#hostnames.some((hostname) => !validHostnameRule(hostname))) {
            throw new Error('network hostname allowlist contains an invalid rule');
        }
        const cidrs = [...new Set((declaration.cidrs ?? []).map((cidr) => cidr.trim()))].sort();
        if (declaration.mode === 'off' && (this.#hostnames.length > 0 || cidrs.length > 0)) {
            throw new Error('network allowlists require mode=allowlist');
        }
        if (declaration.mode === 'allowlist' && this.#hostnames.length === 0 && cidrs.length === 0) {
            throw new Error('allowlist mode requires at least one hostname or CIDR');
        }
        for (const cidr of cidrs) {
            const network = cidr.split('/')[0];
            if (network && isIP(network) === 6) {
                throw new Error('IPv6 egress allowlists are unavailable while managed IPv6 is disabled');
            }
            addCidr(this.#allowedAddresses, cidr);
        }
        // Validate every deployment-specific deny rule at policy construction.
        for (const cidr of additionalBlockedCidrs) {
            const validation = new BlockList();
            addCidr(validation, cidr);
        }
        this.declaration = {
            mode: declaration.mode,
            hostnames: this.#hostnames,
            cidrs
        };
    }
    allowsHostname(hostname) {
        if (this.declaration.mode === 'off')
            return false;
        const normalized = normalizeHostname(hostname);
        return this.#hostnames.some((rule) => hostnameMatches(rule, normalized));
    }
    learnDns(hostname, addresses, ttlSeconds, now = Date.now()) {
        const normalized = normalizeHostname(hostname);
        if (!this.allowsHostname(normalized))
            throw new Error('hostname is not allowlisted');
        if (!addresses.length)
            throw new Error('DNS response has no addresses');
        if (addresses.some((ip) => isHardBlockedAddress(ip, this.additionalBlockedCidrs))) {
            throw new Error('DNS response resolves into the Nehemiah hard-deny floor');
        }
        const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 5), 300);
        for (const address of addresses) {
            if (isIP(address) === 0)
                throw new Error('DNS response contains an invalid address');
            this.#learned.set(address, { hostname: normalized, expiresAt: now + ttl * 1_000 });
        }
    }
    allowsAddress(ip, now = Date.now()) {
        if (this.declaration.mode === 'off' || isHardBlockedAddress(ip, this.additionalBlockedCidrs)) {
            return false;
        }
        const version = isIP(ip);
        if (version !== 0 && this.#allowedAddresses.check(ip, version === 4 ? 'ipv4' : 'ipv6')) {
            return true;
        }
        const learned = this.#learned.get(ip);
        if (!learned)
            return false;
        if (learned.expiresAt <= now) {
            this.#learned.delete(ip);
            return false;
        }
        return true;
    }
}
//# sourceMappingURL=network-policy.js.map