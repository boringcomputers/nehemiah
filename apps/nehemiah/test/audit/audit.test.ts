import { describe, expect, it, vi } from 'vitest';
import {
	AuditCompletionUnavailable,
	AuditService,
	auditUserAgentFingerprint
} from '../../src/audit/audit.js';
import type { Queryable } from '../../src/db/client.js';

class RecordingDatabase implements Queryable {
	readonly calls: Array<{ text: string; values: ReadonlyArray<unknown> }> = [];

	constructor(private readonly failAt?: number) {}

	async query(_text: string, values: ReadonlyArray<unknown> = []) {
		this.calls.push({ text: _text, values });
		if (this.calls.length === this.failAt) throw new Error('audit database unavailable');
		return { rows: [], rowCount: 1 } as never;
	}
}

const base = {
	organizationId: '55ea6a17-47bc-472e-b07a-69d5e9f6bc4e',
	projectId: '80ded43c-c6bd-4181-bc8c-594ab0bd3ad2',
	actorType: 'api_key' as const,
	actorId: 'key-1',
	requestId: 'request-1',
	userAgent: 'audit-test',
	action: 'machine.create',
	resourceType: 'machine'
};

describe('durable audit capture', () => {
	it('fingerprints caller-controlled user agents before they reach SQL', async () => {
		const database = new RecordingDatabase();
		const audit = new AuditService(database);
		const hostile = `Bearer bc_live_deadbeefcafe_${'S'.repeat(43)}`;
		await audit.record({
			...base,
			userAgent: hostile,
			outcome: 'denied',
			reasonCode: 'scope_denied'
		});
		expect(database.calls[0]?.values[12]).toBe(auditUserAgentFingerprint(hostile));
		expect(JSON.stringify(database.calls)).not.toContain(hostile);
	});

	it('stores only a bounded slot for authentication deduplication', async () => {
		const database = new RecordingDatabase();
		const secret = `bc_live_deadbeefcafe_${'T'.repeat(43)}`;
		await new AuditService(database).authentication({
			action: 'authentication',
			credentialKind: 'api_key',
			dedupeIdentity: secret,
			outcome: 'denied',
			reasonCode: 'credential_invalid_or_inactive',
			actorType: 'api_key',
			actorId: 'bc_live_deadbeefcafe',
			requestId: 'request-1',
			userAgent: secret,
			source: 'ipv4:203.0.113.0/24',
			route: '/v1/machines',
			method: 'GET'
		});
		expect(database.calls[0]?.values[2]).toEqual(expect.any(Number));
		expect(database.calls[0]?.values[2]).toBeGreaterThanOrEqual(0);
		expect(database.calls[0]?.values[2]).toBeLessThan(65_536);
		expect(JSON.stringify(database.calls)).not.toContain(secret);
	});

	it('writes intent before work and a correlated terminal outcome afterward', async () => {
		const database = new RecordingDatabase();
		const audit = new AuditService(database);
		const result = await audit.capture(
			{
				...base,
				metadata: { region: 'ca-tor-1' },
				complete: (machine: { id: string }) => ({
					resourceId: machine.id,
					metadata: { state: 'running' }
				})
			},
			async () => ({ id: 'm_audit-machine' })
		);

		expect(result.id).toBe('m_audit-machine');
		expect(database.calls).toHaveLength(2);
		const requested = database.calls[0]!.values;
		const succeeded = database.calls[1]!.values;
		expect(requested[1]).toBe(succeeded[1]);
		expect(requested).toMatchObject({
			2: base.organizationId,
			3: base.projectId,
			4: 'api_key',
			6: 'machine.create',
			7: 'requested',
			10: null
		});
		expect(succeeded).toMatchObject({
			7: 'succeeded',
			10: 'm_audit-machine',
			13: { state: 'running' }
		});
	});

	it('fails closed without invoking work when durable intent cannot be written', async () => {
		const audit = new AuditService(new RecordingDatabase(1));
		const work = vi.fn(async () => 'not-run');

		await expect(audit.capture(base, work)).rejects.toThrow('audit database unavailable');
		expect(work).not.toHaveBeenCalled();
	});

	it('records a safe failure code without persisting an error message', async () => {
		const database = new RecordingDatabase();
		const audit = new AuditService(database);
		const failure = Object.assign(new Error('secret command and bearer token'), {
			code: 'capacity_unavailable'
		});

		await expect(
			audit.capture(base, async () => {
				throw failure;
			})
		).rejects.toBe(failure);

		expect(database.calls).toHaveLength(2);
		const failed = database.calls[1]!.values;
		expect(failed[7]).toBe('failed');
		expect(failed[8]).toBe('capacity_unavailable');
		expect(JSON.stringify(failed)).not.toContain(failure.message);
	});

	it('surfaces a terminal audit failure after work while retaining requested intent', async () => {
		const database = new RecordingDatabase(2);
		const audit = new AuditService(database);
		const work = vi.fn(async () => 'completed');

		await expect(audit.capture(base, work)).rejects.toBeInstanceOf(AuditCompletionUnavailable);
		expect(work).toHaveBeenCalledOnce();
		expect(database.calls[0]!.values[7]).toBe('requested');
		expect(database.calls[1]!.values[7]).toBe('succeeded');
		expect(database.calls[0]!.values[1]).toBe(database.calls[1]!.values[1]);
	});
});
