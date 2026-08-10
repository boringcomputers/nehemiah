import { type HostCapacity, type Resources } from './capacity.js';
export interface PlacementRequest {
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly resources: Resources;
    readonly templateId?: string;
}
/** Deterministic best-fit: cached image first, then least residual memory, then host ID. */
export declare const chooseHost: (hosts: ReadonlyArray<HostCapacity>, request: PlacementRequest) => HostCapacity | undefined;
