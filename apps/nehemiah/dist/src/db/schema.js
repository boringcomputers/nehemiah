export const machineStates = [
    'requested',
    'placing',
    'starting',
    'running',
    'stopping',
    'stopped',
    'failed',
    'lost'
];
export const hostStates = ['ready', 'draining', 'unhealthy', 'stale'];
export const isMachineState = (value) => typeof value === 'string' && machineStates.includes(value);
//# sourceMappingURL=schema.js.map