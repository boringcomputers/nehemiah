import type { Database } from '../db/client.js';
import type { MachineService } from '../domain/machines.js';
export declare const reapExpiredMachines: (database: Database, machines: MachineService) => Promise<void>;
