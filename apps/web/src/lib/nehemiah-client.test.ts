import { describe, expect, it } from 'vitest';
import {
	DashboardApiError,
	machinePreviewUrl,
	machineWebSocketSession,
	organizationForDashboard,
	type DashboardMachineSession
} from './nehemiah-client';

describe('dashboard client errors', () => {
	it('prefers RFC 9457 detail text', () => {
		const error = new DashboardApiError(403, {
			title: 'insufficient_scope',
			detail: 'machines:write is required.'
		});
		expect(error.message).toBe('machines:write is required.');
		expect(error.status).toBe(403);
	});
});

describe('dashboard organization selection', () => {
	const organizations = [{ id: 'org-a' }, { id: 'org-b' }];

	it('keeps a previous selection that the user can still access', () => {
		expect(organizationForDashboard(organizations, 'org-b')).toBe('org-b');
	});

	it('falls back to the first organization when a stored selection is stale', () => {
		expect(organizationForDashboard(organizations, 'org-removed')).toBe('org-a');
	});

	it('returns undefined when the user has no organizations', () => {
		expect(organizationForDashboard([], 'org-a')).toBeUndefined();
	});
});

describe('machine session links', () => {
	const session: DashboardMachineSession = {
		token: 'short-lived-capability',
		expires_in: 300,
		gateway_url: 'https://gateway.example/base?ignored=yes'
	};

	it('keeps credentials out of the WebSocket URL and uses a scoped subprotocol', () => {
		expect(machineWebSocketSession(session, 'm_123', 'tty')).toEqual({
			url: 'wss://gateway.example/v1/machines/m_123/tty',
			protocols: ['nehemiah.capability.short-lived-capability']
		});
	});

	it('accepts a wildcard preview origin with fragment-based authentication', () => {
		expect(
			machinePreviewUrl(
				{
					...session,
					preview_url:
						'https://lease--3000.preview.example/preview/m_123/3000/#token=short-lived-bootstrap'
				},
				'm_123',
				3000
			)
		).toBe('https://lease--3000.preview.example/preview/m_123/3000/#token=short-lived-bootstrap');
	});

	it('rejects query-string preview authentication', () => {
		expect(() =>
			machinePreviewUrl(
				{
					...session,
					preview_url:
						'https://lease--3000.preview.example/preview/m_123/3000/?token=leaked#token=bootstrap'
				},
				'm_123',
				3000
			)
		).toThrow('preview URL is invalid');
	});

	it('rejects a preview URL for a different machine or port', () => {
		expect(() =>
			machinePreviewUrl(
				{
					...session,
					preview_url: 'https://lease--3001.preview.example/preview/m_other/3001/#token=bootstrap'
				},
				'm_123',
				3000
			)
		).toThrow('preview URL is invalid');
	});

	it('rejects preview credentials embedded in the URL authority', () => {
		expect(() =>
			machinePreviewUrl(
				{
					...session,
					preview_url:
						'https://user:secret@lease--3000.preview.example/preview/m_123/3000/#token=bootstrap'
				},
				'm_123',
				3000
			)
		).toThrow('preview URL is invalid');
	});
});
