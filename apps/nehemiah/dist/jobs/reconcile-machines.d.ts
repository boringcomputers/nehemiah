import type { UsageLedger } from '../billing/usage.js';
import type { AuthoritativeMetering } from '../billing/metering.js';
import type { HostClient } from '../clients/nehemiahd.js';
import type { Database } from '../db/client.js';
export declare class MachineReconciler {
    private readonly database;
    private readonly host;
    private readonly usage?;
    private readonly metering?;
    private readonly machines;
    constructor(database: Database, host: HostClient, usage?: UsageLedger | undefined, metering?: AuthoritativeMetering | undefined);
    run(): Promise<void>;
    private runLocked;
    private closeUnfinalizedAuthoritativeTerminals;
    private reconcileFork;
    private finishForkCleanup;
    private cleanupForkObservations;
    private claimReconcileBatch;
    private releaseReconcileClaim;
    private reconcile;
    private markLostOnStaleHosts;
    private finishAndRelease;
    private releaseLeakedReservations;
    private release;
    private event;
    private enqueueUsageIntervals;
    private flushUsageOutbox;
}
