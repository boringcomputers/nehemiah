export const machineStates = [
	'requested',
	'placing',
	'starting',
	'running',
	'stopping',
	'stopped',
	'failed',
	'lost'
] as const;

export type MachineState = (typeof machineStates)[number];

export const hostStates = ['ready', 'draining', 'unhealthy', 'stale'] as const;
export type HostState = (typeof hostStates)[number];

export interface DatabaseMachine {
	readonly id: string;
	readonly organization_id: string;
	readonly project_id: string;
	readonly host_id: string | null;
	readonly host_machine_id: string | null;
	readonly lease_id: string;
	readonly state: MachineState;
	readonly ready: boolean;
	readonly started_at: Date | null;
	readonly ready_at: Date | null;
	readonly stopped_at: Date | null;
	readonly expires_at: Date;
}

export const isMachineState = (value: unknown): value is MachineState =>
	typeof value === 'string' && machineStates.includes(value as MachineState);
