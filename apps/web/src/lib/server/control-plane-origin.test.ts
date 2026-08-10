import { describe, expect, it } from 'vitest';
import { controlPlaneOrigin } from './control-plane-origin';

describe('controlPlaneOrigin', () => {
	it('accepts only a bare HTTPS production origin', () => {
		expect(controlPlaneOrigin('https://api.example.test/', false)).toBe('https://api.example.test');
		for (const value of [
			'http://api.example.test',
			'https://user:pass@api.example.test',
			'https://api.example.test/v1',
			'https://api.example.test?x=1',
			'https://api.example.test/#x',
			'not-a-url'
		]) {
			expect(controlPlaneOrigin(value, false)).toBeUndefined();
		}
	});

	it('allows HTTP only on exact loopback hosts in development', () => {
		for (const value of ['http://localhost:8081', 'http://127.0.0.1:8081', 'http://[::1]:8081']) {
			expect(controlPlaneOrigin(value, true)).toBe(value);
		}
		expect(controlPlaneOrigin('http://localhost.example:8081', true)).toBeUndefined();
		expect(controlPlaneOrigin('http://192.0.2.1:8081', true)).toBeUndefined();
	});
});
