export declare class UnsafeLocalPath extends Error {
    readonly code = "unsafe_local_path";
}
/** Read one stable regular file without following a final-component symlink. */
export declare function readBoundedLocalFile(path: string, maximumBytes?: number): Promise<Uint8Array>;
/** Atomically replace one explicit destination with a user-only regular file. */
export declare function writePrivateAtomic(path: string, data: Uint8Array): Promise<string>;
