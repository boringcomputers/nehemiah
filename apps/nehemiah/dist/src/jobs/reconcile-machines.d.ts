import type { HostClient } from '../clients/nehemiahd.js';
import type { Database } from '../db/client.js';
export declare class MachineReconciler {
    private readonly database;
    private readonly host;
    constructor(database: Database, host: HostClient);
    run(): Promise<void>;
    private reconcile;
    private markLostOnStaleHosts;
    private finishAndRelease;
    private release;
}
