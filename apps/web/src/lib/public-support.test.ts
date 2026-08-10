import { describe, expect, it } from 'vitest';
import { publicSupportConfig } from './public-support';

describe('public support configuration', () => {
	it('returns only bounded public HTTPS contact values', () => {
		expect(
			publicSupportConfig(
				{
					url: 'https://support.example.com/help',
					email: 'help+cloud@Example.com'
				},
				true
			)
		).toEqual({
			url: 'https://support.example.com/help',
			email: 'help+cloud@example.com'
		});
	});

	it('omits unsafe URL credentials, CRLF, query data, and malformed mail addresses', () => {
		for (const input of [
			{ url: 'https://user:secret@support.example.com/help' },
			{ url: 'https://support.example.com/help?token=secret' },
			{ url: 'https://support.example.com/help%0d%0aheader' },
			{ url: 'http://support.example.com/help' },
			{ url: 'https://localhost/help' },
			{ email: 'support@example.com\r\nBcc:attacker@example.com' },
			{ email: 'Support Team <support@example.com>' },
			{ email: `${'a'.repeat(255)}@example.com` }
		]) {
			expect(publicSupportConfig(input, true)).toEqual({});
		}
	});

	it('allows HTTP only for a loopback development support portal', () => {
		expect(
			publicSupportConfig(
				{ url: 'http://127.0.0.1:5173/support', email: 'support@localhost' },
				false
			)
		).toEqual({
			url: 'http://127.0.0.1:5173/support',
			email: 'support@localhost'
		});
	});
});
