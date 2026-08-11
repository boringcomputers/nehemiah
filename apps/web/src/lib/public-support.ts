export interface PublicSupportConfig {
	readonly url?: string;
	readonly email?: string;
}

const hasControlCharacter = (value: string): boolean =>
	[...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 31 || code === 127;
	});

const hasNonEmailCharacter = (value: string): boolean =>
	[...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 32 || code >= 127;
	});

const loopbackHostname = (hostname: string): boolean => {
	if (hostname === 'localhost' || hostname === '[::1]') return true;
	const octets = hostname.split('.');
	return (
		octets.length === 4 &&
		octets[0] === '127' &&
		octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
	);
};

const safeSupportUrl = (value: string | undefined, production: boolean): string | undefined => {
	if (
		!value ||
		value.length > 2_048 ||
		value.trim() !== value ||
		hasControlCharacter(value) ||
		/%(?:0a|0d)/i.test(value)
	) {
		return undefined;
	}
	try {
		const url = new URL(value);
		const loopback = loopbackHostname(url.hostname);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.hostname.endsWith('.') ||
			(production && (url.protocol !== 'https:' || loopback)) ||
			(!production && url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
		) {
			return undefined;
		}
		return url.toString();
	} catch {
		return undefined;
	}
};

const safeSupportEmail = (value: string | undefined, production: boolean): string | undefined => {
	if (!value || value.length > 254 || value.trim() !== value || hasNonEmailCharacter(value)) {
		return undefined;
	}
	const parts = value.split('@');
	if (parts.length !== 2) return undefined;
	const [local, rawDomain] = parts;
	if (
		!local ||
		!rawDomain ||
		local.length > 64 ||
		local.startsWith('.') ||
		local.endsWith('.') ||
		local.includes('..') ||
		!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
	) {
		return undefined;
	}
	const domain = rawDomain.toLowerCase();
	if (production && !domain.includes('.')) return undefined;
	if (
		domain.length > 253 ||
		domain.includes('..') ||
		domain
			.split('.')
			.some(
				(label) =>
					label.length === 0 ||
					label.length > 63 ||
					!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
			)
	) {
		return undefined;
	}
	return `${local}@${domain}`;
};

/** Unsafe deployment values are omitted rather than reflected into public HTML. */
export const publicSupportConfig = (
	input: PublicSupportConfig,
	production: boolean
): PublicSupportConfig => {
	const url = safeSupportUrl(input.url, production);
	const email = safeSupportEmail(input.email, production);
	return { ...(url ? { url } : {}), ...(email ? { email } : {}) };
};
