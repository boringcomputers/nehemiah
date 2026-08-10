const loopbackHostname = (hostname: string): boolean =>
	hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

export const controlPlaneOrigin = (
	value: string | undefined,
	development: boolean
): string | undefined => {
	if (!value) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== '' && url.pathname !== '/')
	) {
		return undefined;
	}
	if (url.protocol === 'https:') return url.origin;
	if (development && url.protocol === 'http:' && loopbackHostname(url.hostname)) return url.origin;
	return undefined;
};
