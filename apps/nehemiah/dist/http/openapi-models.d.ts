export interface GeneratedModelFile {
    readonly path: string;
    readonly contents: string;
}
export declare function generateOpenApiModels(document: unknown): ReadonlyArray<GeneratedModelFile>;
