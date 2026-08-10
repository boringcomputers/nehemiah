import {
	runtimeCohortId,
	runtimeCohortWire,
	type RuntimeCohort
} from '../src/domain/runtime-cohort.js';

const unsigned = {
	contractVersion: 4,
	arch: 'amd64',
	kernelSha256: '1'.repeat(64),
	firecrackerSha256: '2'.repeat(64),
	jailerSha256: '3'.repeat(64),
	pythonRootfsSha256: '4'.repeat(64),
	desktopRootfsSha256: '5'.repeat(64)
} as const;

export const testRuntimeCohort: RuntimeCohort = {
	id: runtimeCohortId(unsigned),
	...unsigned
};

export const testRuntimeCohortWire = runtimeCohortWire(testRuntimeCohort);
