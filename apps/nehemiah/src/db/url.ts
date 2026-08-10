/** Return a secret-free production PostgreSQL URL validation error. */
export const productionDatabaseUrlIssue = (raw: string): string | undefined => {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return 'must be an absolute PostgreSQL URL';
	}
	if (
		!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
		!parsed.username ||
		!parsed.password ||
		!parsed.hostname ||
		parsed.pathname.length <= 1 ||
		parsed.hash
	) {
		return 'must include a PostgreSQL scheme, credentials, host, and database name';
	}
	const sslModes = parsed.searchParams.getAll('sslmode');
	if (sslModes.length !== 1 || sslModes[0] !== 'verify-full' || parsed.searchParams.has('ssl')) {
		return 'must set exactly sslmode=verify-full and may not use an overriding ssl parameter';
	}
	return undefined;
};
