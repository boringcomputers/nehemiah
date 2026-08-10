import { Database } from '../db/client.js';
export interface DeviceRetentionReport {
    readonly skipped: boolean;
    readonly accessTokens: number;
    readonly refreshTokens: number;
    readonly families: number;
    readonly authorizations: number;
}
/**
 * Reap a bounded terminal batch. The session advisory lock makes the job a
 * singleton across replicas; SKIP LOCKED remains defense-in-depth against an
 * operator transaction inspecting one of the same credential rows.
 */
export declare const reapExpiredDeviceAuthorizations: (database: Database, options?: {
    readonly accessBatch?: number;
    readonly familyBatch?: number;
    readonly authorizationBatch?: number;
}) => Promise<DeviceRetentionReport>;
