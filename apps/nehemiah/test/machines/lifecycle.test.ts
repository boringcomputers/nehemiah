import { describe, expect, it } from 'vitest';
import type {
	CreateOnHostRequest,
	ForkOnHostChild,
	HostClient,
	HostExecResult,
	HostMachine
} from '../../src/clients/nehemiahd.js';
import { HostForkContractError, HostRequestError } from '../../src/clients/nehemiahd.js';
import {
	MachineService,
	ReplayedCreateFailure,
	ReplayedForkFailure,
	type ExtendOperation,
	type ForkOperation,
	type Machine,
	type MachineRepository,
	type MachineScheduler
} from '../../src/domain/machines.js';
import type { MachineState } from '../../src/db/schema.js';
import { CapacityUnavailable, type Reservation } from '../../src/scheduler/scheduler.js';

class MemoryMachines implements MachineRepository {
	readonly machines = new Map<string, Machine>();
	readonly keys = new Map<string, string>();
	readonly createClaims = new Map<string, string>();
	readonly extendOperations = new Map<string, ExtendOperation>();
	readonly forkOperations = new Map<string, ForkOperation>();
	async find(id: string, organizationId: string, projectId?: string): Promise<Machine | undefined> {
		const machine = this.machines.get(id);
		return machine?.organizationId === organizationId &&
			(projectId === undefined || machine.projectId === projectId)
			? machine
			: undefined;
	}
	async findByIdempotency(
		organizationId: string,
		projectId: string,
		key: string
	): Promise<Machine | undefined> {
		const id = this.keys.get(`${organizationId}:${projectId}:${key}`);
		const machine = id ? this.machines.get(id) : undefined;
		return machine?.projectId === projectId ? machine : undefined;
	}
	async list(organizationId: string, projectId?: string): Promise<Machine[]> {
		return [...this.machines.values()].filter(
			(machine) =>
				machine.organizationId === organizationId &&
				(projectId === undefined || machine.projectId === projectId)
		);
	}
	async insertRequested(machine: Machine, idempotencyKey: string): Promise<void> {
		const key = `${machine.organizationId}:${machine.projectId}:${idempotencyKey}`;
		if (this.keys.has(key)) throw new Error('duplicate idempotency key');
		this.machines.set(machine.id, machine);
		this.keys.set(key, machine.id);
	}
	async claimCreate(machineId: string): Promise<string | undefined> {
		const machine = this.machines.get(machineId);
		if (!machine || machine.state !== 'requested' || this.createClaims.has(machineId))
			return undefined;
		const token = `claim-${machineId}`;
		this.createClaims.set(machineId, token);
		return token;
	}
	async releaseCreateClaim(machineId: string, claimToken: string): Promise<void> {
		if (this.createClaims.get(machineId) === claimToken) this.createClaims.delete(machineId);
	}
	async failCreate(
		machineId: string,
		claimToken: string,
		status: number,
		code: string,
		message: string
	): Promise<boolean> {
		const machine = this.machines.get(machineId);
		if (
			!machine ||
			this.createClaims.get(machineId) !== claimToken ||
			!['requested', 'placing', 'starting'].includes(machine.state)
		) {
			return false;
		}
		this.createClaims.delete(machineId);
		this.machines.set(machineId, {
			...machine,
			state: 'failed',
			stateReason: message,
			createFailureStatus: status,
			createFailureCode: code,
			createFailureMessage: message
		});
		return true;
	}
	async assign(machineId: string, reservation: Reservation): Promise<void> {
		const machine = this.machines.get(machineId)!;
		this.machines.set(machineId, {
			...machine,
			state: 'starting',
			hostId: reservation.hostId,
			hostAddress: reservation.address
		});
	}
	async observeHost(machineId: string, observed: HostMachine): Promise<void> {
		const machine = this.machines.get(machineId)!;
		this.createClaims.delete(machineId);
		this.machines.set(machineId, {
			...machine,
			hostMachineId: observed.id,
			state: observed.ready ? 'running' : 'starting',
			ready: observed.ready === true,
			startedAt: new Date(),
			readyAt: observed.ready ? new Date() : undefined
		});
	}
	async transition(
		machineId: string,
		from: ReadonlyArray<MachineState>,
		to: MachineState,
		reason?: string
	): Promise<boolean> {
		const machine = this.machines.get(machineId)!;
		if (!from.includes(machine.state)) return false;
		if (['stopped', 'failed', 'lost'].includes(to)) this.createClaims.delete(machineId);
		this.machines.set(machineId, { ...machine, state: to, stateReason: reason });
		return true;
	}
	async beginExtend(
		machineId: string,
		organizationId: string,
		projectId: string,
		idempotencyKey: string,
		requestHash: string,
		ttlSeconds: number
	): Promise<ExtendOperation | undefined> {
		const machine = this.machines.get(machineId);
		if (!machine || machine.organizationId !== organizationId || machine.projectId !== projectId)
			return undefined;
		const key = `${organizationId}:${machineId}:${idempotencyKey}`;
		const existing = this.extendOperations.get(key);
		if (existing) return { ...existing, replayed: true };
		const priorTarget = Math.max(
			machine.expiresAt.getTime(),
			...[...this.extendOperations.values()].map(({ targetExpiresAt }) => targetExpiresAt.getTime())
		);
		const operation = {
			id: String(this.extendOperations.size + 1),
			requestHash,
			targetExpiresAt: new Date(Math.max(priorTarget, Date.now() + ttlSeconds * 1_000)),
			replayed: false
		} satisfies ExtendOperation;
		this.extendOperations.set(key, operation);
		return operation;
	}
	async completeExtend(
		operationId: string,
		machineId: string,
		organizationId: string,
		resultExpiresAt: Date
	): Promise<Date> {
		const entry = [...this.extendOperations.entries()].find(
			([, operation]) => operation.id === operationId
		);
		if (!entry) throw new Error('missing extend operation');
		const recorded = entry[1].resultExpiresAt ?? resultExpiresAt;
		this.extendOperations.set(entry[0], { ...entry[1], resultExpiresAt: recorded });
		const machine = this.machines.get(machineId);
		if (machine?.organizationId === organizationId) {
			this.machines.set(machineId, {
				...machine,
				expiresAt: new Date(Math.max(machine.expiresAt.getTime(), recorded.getTime()))
			});
		}
		return recorded;
	}
	async beginFork(
		sourceMachineId: string,
		organizationId: string,
		projectId: string,
		idempotencyKey: string,
		requestHash: string,
		count: number,
		auditOperationId: string
	): Promise<ForkOperation | undefined> {
		const source = this.machines.get(sourceMachineId);
		if (
			!source ||
			source.organizationId !== organizationId ||
			source.projectId !== projectId ||
			source.state !== 'running' ||
			!source.ready ||
			!source.hostId ||
			!source.hostAddress ||
			!source.hostMachineId
		) {
			return undefined;
		}
		const operationKey = `${organizationId}:${sourceMachineId}:${idempotencyKey}`;
		const prior = this.forkOperations.get(operationKey);
		if (prior) return { ...prior, replayed: true };
		const operationId = `00000000-0000-4000-8000-${String(this.forkOperations.size + 1).padStart(12, '0')}`;
		const children = Array.from({ length: count }, (_, ordinal): Machine => {
			const child: Machine = {
				...source,
				id: `m_forkchild${String(this.forkOperations.size + 1).padStart(4, '0')}${String(ordinal).padStart(4, '0')}`,
				leaseId: `00000000-0000-4000-9000-${String(ordinal + 1).padStart(12, '0')}`,
				hostMachineId: undefined,
				state: 'starting',
				ready: false,
				createdAt: new Date(),
				startedAt: undefined,
				readyAt: undefined,
				parentId: sourceMachineId,
				forkOperationId: operationId
			};
			this.machines.set(child.id, child);
			return child;
		});
		const operation: ForkOperation = {
			id: operationId,
			auditOperationId,
			idempotencyKey,
			requestHash,
			state: 'pending',
			replayed: false,
			sourceMachineId,
			sourceHostId: source.hostId,
			sourceHostAddress: source.hostAddress,
			sourceHostMachineId: source.hostMachineId,
			sourceLeaseId: source.leaseId,
			children,
			cleanupRequested: false,
			expired: false,
			deadlineReached: false
		};
		this.forkOperations.set(operationKey, operation);
		return operation;
	}
	async completeFork(
		operationId: string,
		observed: ReadonlyArray<HostMachine>
	): Promise<ForkOperation> {
		const entry = [...this.forkOperations.entries()].find(
			([, operation]) => operation.id === operationId
		);
		if (!entry) throw new Error('missing fork operation');
		if (entry[1].state !== 'pending' || entry[1].cleanupRequested) return entry[1];
		const allReady = observed.every(
			(machine) => machine.ready === true && machine.status === 'running'
		);
		const children = entry[1].children.map((child) => {
			const hostMachine = observed.find(
				(machine) => machine.metadata?.public_machine_id === child.id
			);
			if (!hostMachine || hostMachine.lease_id !== child.leaseId)
				throw new Error('missing fork child');
			const completed = {
				...child,
				hostMachineId: hostMachine.id,
				state: allReady ? ('running' as const) : ('starting' as const),
				ready: allReady,
				startedAt: new Date(),
				readyAt: allReady ? new Date() : undefined
			};
			this.machines.set(completed.id, completed);
			return completed;
		});
		const completed = {
			...entry[1],
			state: allReady ? ('succeeded' as const) : ('pending' as const),
			children,
			replayed: true
		};
		this.forkOperations.set(entry[0], completed);
		return completed;
	}
	async failFork(
		operationId: string,
		status: number,
		code: string,
		message: string
	): Promise<ForkOperation> {
		const entry = [...this.forkOperations.entries()].find(
			([, operation]) => operation.id === operationId
		);
		if (!entry) throw new Error('missing fork operation');
		if (entry[1].state !== 'pending' || entry[1].cleanupRequested) return entry[1];
		for (const child of entry[1].children) {
			this.machines.set(child.id, { ...child, state: 'failed', stateReason: message });
		}
		const failed = {
			...entry[1],
			state: 'failed' as const,
			failureStatus: status,
			failureCode: code,
			failureMessage: message,
			replayed: true
		};
		this.forkOperations.set(entry[0], failed);
		return failed;
	}
	async requestForkCleanup(
		operationId: string,
		status: number,
		code: string,
		message: string
	): Promise<ForkOperation> {
		const entry = [...this.forkOperations.entries()].find(
			([, operation]) => operation.id === operationId
		);
		if (!entry) throw new Error('missing fork operation');
		if (entry[1].state !== 'pending') return entry[1];
		if (entry[1].cleanupClaimToken) {
			return { ...entry[1], cleanupClaimToken: undefined, replayed: true };
		}
		const cleanup = {
			...entry[1],
			cleanupRequested: true,
			cleanupClaimToken: `cleanup-${operationId}`,
			cleanupFailureStatus: entry[1].cleanupFailureStatus ?? status,
			cleanupFailureCode: entry[1].cleanupFailureCode ?? code,
			cleanupFailureMessage: entry[1].cleanupFailureMessage ?? message,
			replayed: true
		};
		this.forkOperations.set(entry[0], cleanup);
		return cleanup;
	}
	async completeForkCleanup(
		operationId: string,
		cleanupClaimToken: string
	): Promise<ForkOperation> {
		const entry = [...this.forkOperations.entries()].find(
			([, operation]) => operation.id === operationId
		);
		if (!entry) throw new Error('missing fork operation');
		if (
			entry[1].state !== 'pending' ||
			entry[1].cleanupClaimToken !== cleanupClaimToken ||
			entry[1].cleanupFailureStatus === undefined ||
			entry[1].cleanupFailureCode === undefined ||
			entry[1].cleanupFailureMessage === undefined
		) {
			return entry[1];
		}
		for (const child of entry[1].children) {
			this.machines.set(child.id, {
				...child,
				state: 'failed',
				ready: false,
				stateReason: entry[1].cleanupFailureMessage
			});
		}
		const failed: ForkOperation = {
			...entry[1],
			state: 'failed',
			failureStatus: entry[1].cleanupFailureStatus,
			failureCode: entry[1].cleanupFailureCode,
			failureMessage: entry[1].cleanupFailureMessage,
			cleanupClaimToken: undefined,
			replayed: true
		};
		this.forkOperations.set(entry[0], failed);
		return failed;
	}
	async releaseForkCleanupClaim(operationId: string, cleanupClaimToken: string): Promise<void> {
		const entry = [...this.forkOperations.entries()].find(
			([, operation]) => operation.id === operationId
		);
		if (entry?.[1].cleanupClaimToken === cleanupClaimToken) {
			this.forkOperations.set(entry[0], {
				...entry[1],
				cleanupClaimToken: undefined,
				replayed: true
			});
		}
	}
	async claimPendingForks(): Promise<ReadonlyArray<ForkOperation>> {
		return [...this.forkOperations.values()].filter(({ state }) => state === 'pending');
	}
	async releaseForkClaim(): Promise<void> {}
}

class FakeScheduler implements MachineScheduler {
	reservations = 0;
	releases = 0;
	async reserve(): Promise<Reservation> {
		this.reservations += 1;
		return { hostId: 'host-a', address: '10.0.0.2:8080', cachedTemplate: true };
	}
	async release(): Promise<void> {
		this.releases += 1;
	}
}

class UnavailableScheduler implements MachineScheduler {
	async reserve(): Promise<Reservation> {
		throw new CapacityUnavailable('No healthy host has enough reserved capacity.');
	}
	async release(): Promise<void> {}
}

class FakeHost implements HostClient {
	creates: CreateOnHostRequest[] = [];
	destroys = 0;
	extends: Array<{ key: string; target: Date }> = [];
	forks: Array<{ key: string; children: ReadonlyArray<ForkOnHostChild> }> = [];
	async create(_address: string, request: CreateOnHostRequest): Promise<HostMachine> {
		this.creates.push(request);
		return {
			id: 'local-1',
			status: 'running',
			ready: true,
			lease_id: request.leaseId,
			metadata: request.metadata
		};
	}
	async get(): Promise<HostMachine | undefined> {
		return undefined;
	}
	async destroy(): Promise<void> {
		this.destroys += 1;
	}
	async extend(
		_address: string,
		_hostMachineId: string,
		leaseId: string,
		idempotencyKey: string,
		targetExpiresAt: Date
	): Promise<HostMachine> {
		this.extends.push({ key: idempotencyKey, target: targetExpiresAt });
		return {
			id: 'local-1',
			status: 'running',
			ready: true,
			lease_id: leaseId,
			expires_at: targetExpiresAt.toISOString()
		};
	}
	async fork(
		_address: string,
		_sourceHostMachineId: string,
		_sourceLeaseId: string,
		key: string,
		children: ReadonlyArray<ForkOnHostChild>
	): Promise<ReadonlyArray<HostMachine>> {
		this.forks.push({ key, children });
		return children.map((child, index) => ({
			id: `local-fork-${index}`,
			status: 'running',
			ready: true,
			lease_id: child.leaseId,
			metadata: child.metadata,
			expires_at: child.expiresAt.toISOString(),
			resources: {
				vcpus: child.resources.vcpus,
				memory_mb: child.resources.memoryMb,
				disk_mb: child.resources.diskMb
			},
			network_policy: child.networkPolicy
		}));
	}
	async exec(): Promise<HostExecResult> {
		return { stdout: 'ok\n', stderr: '', exit_code: 0, timed_out: false, duration_ms: 1 };
	}
}

const input = {
	organizationId: 'org-a',
	projectId: 'project-a',
	region: 'ca-tor-1',
	architecture: 'x86_64' as const,
	resources: { vcpus: 1, memoryMb: 512, diskMb: 5_120 },
	templateId: 'template-a',
	ttlSeconds: 900,
	idempotencyKey: 'create-1'
};

describe('machine lifecycle', () => {
	it('persists intent, reserves once and distinguishes started from ready', async () => {
		const repository = new MemoryMachines();
		const scheduler = new FakeScheduler();
		const host = new FakeHost();
		const service = new MachineService(repository, scheduler, host);

		const first = await service.create(input);
		const replay = await service.create(input);

		expect(first.machine).toMatchObject({
			state: 'running',
			ready: true,
			hostMachineId: 'local-1'
		});
		expect(replay.replayed).toBe(true);
		expect(scheduler.reservations).toBe(1);
		expect(host.creates).toHaveLength(1);
		expect(host.creates[0]?.metadata).toEqual({ public_machine_id: first.machine.id });
	});

	it('allows only one owner to execute concurrent same-key creates', async () => {
		const repository = new MemoryMachines();
		const scheduler = new FakeScheduler();
		const host = new FakeHost();
		const service = new MachineService(repository, scheduler, host);

		const results = await Promise.all([service.create(input), service.create(input)]);

		expect(new Set(results.map(({ machine }) => machine.id)).size).toBe(1);
		expect(results.some(({ replayed }) => replayed)).toBe(true);
		expect(scheduler.reservations).toBe(1);
		expect(host.creates).toHaveLength(1);
	});

	it('rejects managed CIDR egress before persistence or host admission', async () => {
		const repository = new MemoryMachines();
		const scheduler = new FakeScheduler();
		const host = new FakeHost();
		const service = new MachineService(repository, scheduler, host);
		await expect(
			service.create({
				...input,
				idempotencyKey: 'create-network-policy',
				networkPolicy: { mode: 'allowlist', cidrs: ['1.1.1.0/24'] }
			})
		).rejects.toMatchObject({ code: 'not_supported' });
		expect(scheduler.reservations).toBe(0);
		expect(host.creates).toHaveLength(0);
		expect(await repository.list(input.organizationId, input.projectId)).toHaveLength(0);
	});

	it('rejects malformed network declarations before persisting or scheduling', async () => {
		const repository = new MemoryMachines();
		const scheduler = new FakeScheduler();
		const host = new FakeHost();
		const service = new MachineService(repository, scheduler, host);

		await expect(
			service.create({
				...input,
				idempotencyKey: 'hostname-policy-rejected',
				networkPolicy: { mode: 'allowlist', hostnames: ['not a hostname'] }
			})
		).rejects.toMatchObject({ code: 'invalid_request' });
		expect(scheduler.reservations).toBe(0);
		expect(host.creates).toHaveLength(0);
		expect(await repository.list(input.organizationId, input.projectId)).toHaveLength(0);
	});

	it('replays the original typed create failure without scheduling again', async () => {
		const repository = new MemoryMachines();
		const service = new MachineService(repository, new UnavailableScheduler(), new FakeHost());

		await expect(service.create(input)).rejects.toBeInstanceOf(CapacityUnavailable);
		await expect(service.create(input)).rejects.toMatchObject({
			status: 503,
			code: 'capacity_unavailable',
			message: 'No healthy host has enough reserved capacity.'
		} satisfies Partial<ReplayedCreateFailure>);
	});

	it('makes destroy idempotent and releases capacity exactly once', async () => {
		const repository = new MemoryMachines();
		const scheduler = new FakeScheduler();
		const host = new FakeHost();
		const service = new MachineService(repository, scheduler, host);
		const { machine } = await service.create(input);

		expect(await service.destroy(machine.id, 'org-a', 'project-a')).toBe(true);
		expect(await service.destroy(machine.id, 'org-a', 'project-a')).toBe(true);
		expect(host.destroys).toBe(1);
		expect(scheduler.releases).toBe(1);
		expect((await service.get(machine.id, 'org-a'))?.state).toBe('stopped');
	});

	it('does not disclose or operate another tenant machine', async () => {
		const repository = new MemoryMachines();
		const service = new MachineService(repository, new FakeScheduler(), new FakeHost());
		const { machine } = await service.create(input);
		expect(await service.get(machine.id, 'org-b')).toBeUndefined();
		expect(await service.destroy(machine.id, 'org-b')).toBe(false);
	});

	it('requires an idempotency key and replays a completed absolute extend result', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine } = await service.create(input);

		await expect(service.extend(machine.id, 'org-a', 'project-a', 300, '')).rejects.toThrow(
			'Idempotency-Key'
		);
		const first = await service.extend(machine.id, 'org-a', 'project-a', 300, 'extend-1');
		const replay = await service.extend(machine.id, 'org-a', 'project-a', 300, 'extend-1');

		expect(first.applied).toBe(true);
		expect(first.replayed).toBe(false);
		expect(replay.replayed).toBe(true);
		expect(replay.machine?.expiresAt).toEqual(first.machine?.expiresAt);
		expect(host.extends).toHaveLength(1);
	});

	it('retries an ambiguous host extend with the same persisted target', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine } = await service.create(input);
		const originalExtend = host.extend.bind(host);
		let attempts = 0;
		host.extend = async (...args) => {
			attempts += 1;
			if (attempts === 1) {
				host.extends.push({ key: args[3], target: args[4] });
				throw new HostRequestError(undefined, 'timeout', true);
			}
			return originalExtend(...args);
		};

		await expect(
			service.extend(machine.id, 'org-a', 'project-a', 300, 'extend-timeout')
		).rejects.toBeInstanceOf(HostRequestError);
		const replay = await service.extend(machine.id, 'org-a', 'project-a', 300, 'extend-timeout');

		expect(replay.replayed).toBe(true);
		expect(host.extends).toHaveLength(2);
		expect(host.extends[1]?.target).toEqual(host.extends[0]?.target);
	});

	it('rejects reusing an extend key with a different ttl', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine } = await service.create(input);
		await service.extend(machine.id, 'org-a', 'project-a', 300, 'extend-conflict');

		await expect(
			service.extend(machine.id, 'org-a', 'project-a', 600, 'extend-conflict')
		).rejects.toMatchObject({ code: 'idempotency_conflict' });
		expect(host.extends).toHaveLength(1);
	});

	it('forks and replays one stable all-ready batch', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine: source } = await service.create(input);

		const first = await service.fork(source.id, 'org-a', 'project-a', 2, 'fork-ready');
		const replay = await service.fork(source.id, 'org-a', 'project-a', 2, 'fork-ready');

		expect(first).toMatchObject({ replayed: false, pending: false });
		expect(first.machines).toHaveLength(2);
		expect(first.machines.every((machine) => machine.ready && machine.parentId === source.id)).toBe(
			true
		);
		expect(replay).toMatchObject({ replayed: true, pending: false });
		expect(replay.machines.map(({ id }) => id)).toEqual(first.machines.map(({ id }) => id));
		expect(host.forks).toHaveLength(1);
		expect(host.forks[0]?.children).toHaveLength(2);
		await expect(
			service.fork(source.id, 'org-a', 'project-a', 1, 'fork-ready')
		).rejects.toMatchObject({ code: 'idempotency_conflict' });
	});

	it('keeps a partially ready fork hidden as one pending batch until replay is all ready', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine: source } = await service.create(input);
		const readyFork = host.fork.bind(host);
		let attempts = 0;
		host.fork = async (...args) => {
			const observed = await readyFork(...args);
			attempts += 1;
			return attempts === 1
				? observed.map((machine, index) =>
						index === 1 ? { ...machine, status: 'starting', ready: false } : machine
					)
				: observed;
		};

		const pending = await service.fork(source.id, 'org-a', 'project-a', 2, 'fork-partial');
		expect(pending).toMatchObject({ pending: true, replayed: false });
		expect(
			pending.machines.every((machine) => machine.state === 'starting' && !machine.ready)
		).toBe(true);
		const completed = await service.fork(source.id, 'org-a', 'project-a', 2, 'fork-partial');
		expect(completed).toMatchObject({ pending: false, replayed: true });
		expect(
			completed.machines.every((machine) => machine.state === 'running' && machine.ready)
		).toBe(true);
		expect(host.forks).toHaveLength(2);
	});

	it('returns recoverable pending data when the terminal persistence response is lost', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine: source } = await service.create(input);
		const completeFork = repository.completeFork.bind(repository);
		let loseResponse = true;
		repository.completeFork = async (...args) => {
			const completed = await completeFork(...args);
			if (loseResponse) {
				loseResponse = false;
				throw new Error('commit response lost');
			}
			return completed;
		};

		const pending = await service.fork(
			source.id,
			'org-a',
			'project-a',
			1,
			'fork-persistence-response'
		);
		expect(pending).toMatchObject({
			pending: true,
			cleanupPending: false,
			idempotencyKey: 'fork-persistence-response'
		});
		const recovered = await service.fork(
			source.id,
			'org-a',
			'project-a',
			1,
			pending.idempotencyKey
		);
		expect(recovered).toMatchObject({ pending: false, replayed: true });
		expect(host.forks).toHaveLength(1);
	});

	it('destroys every observed child and replays one terminal fork failure', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine: source } = await service.create(input);
		const readyFork = host.fork.bind(host);
		host.fork = async (...args) => {
			const observed = await readyFork(...args);
			return observed.map((machine, index) =>
				index === 1 ? { ...machine, status: 'failed', ready: false } : machine
			);
		};

		await expect(
			service.fork(source.id, 'org-a', 'project-a', 2, 'fork-terminal')
		).rejects.toBeInstanceOf(ReplayedForkFailure);
		expect(host.destroys).toBe(2);
		await expect(
			service.fork(source.id, 'org-a', 'project-a', 2, 'fork-terminal')
		).rejects.toMatchObject({ code: 'fork_batch_failed', status: 502 });
		expect(host.forks).toHaveLength(1);
		expect(host.destroys).toBe(2);
	});

	it('keeps malformed partial batches pending until the host confirms every survivor is gone', async () => {
		const repository = new MemoryMachines();
		const host = new FakeHost();
		const service = new MachineService(repository, new FakeScheduler(), host);
		const { machine: source } = await service.create(input);
		const readyFork = host.fork.bind(host);
		let attempts = 0;
		host.fork = async (...args) => {
			attempts += 1;
			if (attempts === 1) {
				const observed = await readyFork(...args);
				throw new HostForkContractError('malformed batch', [observed[0]!]);
			}
			throw new HostRequestError(
				422,
				'{"error":"fork_batch_cleaned"}',
				false,
				'fork_batch_cleaned'
			);
		};

		const pending = await service.fork(source.id, 'org-a', 'project-a', 2, 'fork-malformed');
		expect(pending).toMatchObject({ pending: true, cleanupPending: true });
		expect(host.destroys).toBe(1);
		await expect(
			service.fork(source.id, 'org-a', 'project-a', 2, 'fork-malformed')
		).rejects.toMatchObject({ code: 'fork_batch_failed', status: 502 });
		expect(host.destroys).toBe(1);
	});
});
