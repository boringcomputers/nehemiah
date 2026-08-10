import { Data, Effect, Redacted } from 'effect';
export class ConfigError extends Data.TaggedError('ConfigError') {
}
const integer = (env, name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ConfigError({ variable: name, message: 'must be a positive integer' });
    }
    return value;
};
const secret = (env, name, fallback, required) => {
    const value = env[name] || fallback;
    if (required && !env[name]) {
        throw new ConfigError({ variable: name, message: 'is required in production' });
    }
    return Redacted.make(value);
};
/** Load and validate configuration inside Effect so startup failures are typed. */
export const loadConfig = (env = process.env) => Effect.try({
    try: () => {
        const environment = (env.NODE_ENV ?? 'development');
        if (!['development', 'test', 'production'].includes(environment)) {
            throw new ConfigError({
                variable: 'NODE_ENV',
                message: 'must be development, test, or production'
            });
        }
        const production = environment === 'production';
        return {
            environment,
            host: env.NEHEMIAH_HOST ?? '0.0.0.0',
            port: integer(env, 'PORT', 8081),
            databaseUrl: secret(env, 'DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:5432/nehemiah', production),
            internalToken: secret(env, 'NEHEMIAH_INTERNAL_TOKEN', 'dev-internal-token', production),
            gatewayToken: secret(env, 'NEHEMIAH_GATEWAY_TOKEN', 'dev-gateway-token', production),
            clerkIssuer: env.CLERK_ISSUER,
            clerkAudience: env.CLERK_AUDIENCE,
            hostStaleAfterMs: integer(env, 'NEHEMIAH_HOST_STALE_MS', 30_000),
            defaultRegion: env.NEHEMIAH_DEFAULT_REGION ?? 'ca-tor-1'
        };
    },
    catch: (error) => error instanceof ConfigError
        ? error
        : new ConfigError({ variable: 'unknown', message: String(error) })
});
//# sourceMappingURL=config.js.map