import { available, fits, type HostCapacity, type Resources } from './capacity.js';

export interface PlacementRequest {
	readonly region: string;
	readonly architecture: 'x86_64' | 'aarch64';
	readonly resources: Resources;
	readonly templateId?: string;
}

/** Deterministic best-fit: cached image first, then least residual memory, then host ID. */
export const chooseHost = (
	hosts: ReadonlyArray<HostCapacity>,
	request: PlacementRequest
): HostCapacity | undefined =>
	[...hosts]
		.filter(
			(host) =>
				host.region === request.region &&
				host.architecture === request.architecture &&
				fits(host, request.resources)
		)
		.sort((left, right) => {
			const leftCached = request.templateId ? left.cachedTemplates.has(request.templateId) : true;
			const rightCached = request.templateId ? right.cachedTemplates.has(request.templateId) : true;
			if (leftCached !== rightCached) return leftCached ? -1 : 1;
			const memory =
				available(left).memoryMb -
				request.resources.memoryMb -
				(available(right).memoryMb - request.resources.memoryMb);
			if (memory !== 0) return memory;
			const cpu =
				available(left).vcpus -
				request.resources.vcpus -
				(available(right).vcpus - request.resources.vcpus);
			return cpu || left.id.localeCompare(right.id);
		})[0];
