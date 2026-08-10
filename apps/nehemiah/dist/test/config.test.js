import { Effect, Either, Redacted } from 'effect';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
describe('control-plane configuration', () => {
    it('has safe local defaults and redacts secrets', async () => {
        const config = await Effect.runPromise(loadConfig({ NODE_ENV: 'test' }));
        expect(config.port).toBe(8081);
        expect(String(config.databaseUrl)).not.toContain('postgres:postgres');
        expect(Redacted.value(config.internalToken)).toBe('dev-internal-token');
    });
    it('requires production database and internal credentials', async () => {
        const result = await Effect.runPromise(Effect.either(loadConfig({ NODE_ENV: 'production' })));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
            expect(result.left).toMatchObject({ _tag: 'ConfigError', variable: 'DATABASE_URL' });
        }
    });
});
//# sourceMappingURL=config.test.js.map