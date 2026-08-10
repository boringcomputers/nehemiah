export interface Resources {
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskMb: number;
}

export interface HostCapacity extends Resources {
	readonly id: string;
	readonly region: string;
	readonly architecture: 'x86_64' | 'aarch64';
	readonly state: 'ready' | 'draining' | 'unhealthy' | 'stale';
	readonly reservedVcpus: number;
	readonly reservedMemoryMb: number;
	readonly reservedDiskMb: number;
	readonly cachedTemplates: ReadonlySet<string>;
}

export const available = (host: HostCapacity): Resources => ({
	vcpus: host.vcpus - host.reservedVcpus,
	memoryMb: host.memoryMb - host.reservedMemoryMb,
	diskMb: host.diskMb - host.reservedDiskMb
});

export const fits = (host: HostCapacity, resources: Resources): boolean => {
	const free = available(host);
	return (
		host.state === 'ready' &&
		free.vcpus >= resources.vcpus &&
		free.memoryMb >= resources.memoryMb &&
		free.diskMb >= resources.diskMb
	);
};

export const validateResources = (resources: Resources): void => {
	for (const [key, value] of Object.entries(resources)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be positive`);
	}
	if (resources.vcpus > 4) throw new Error('vcpus must not exceed 4');
	if (resources.memoryMb > 4_096) throw new Error('memoryMb must not exceed 4096');
	if (resources.diskMb > 20_480) throw new Error('diskMb must not exceed 20480');
};
