export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface RequestContext<S = unknown> {
    readonly request: Request;
    readonly url: URL;
    readonly params: Readonly<Record<string, string>>;
    readonly requestId: string;
    readonly services: S;
}
export type Handler<S = unknown> = (context: RequestContext<S>) => Response | Promise<Response>;
export declare const json: (body: unknown, status?: number, headers?: HeadersInit) => Response;
export declare const problem: (status: number, code: string, detail: string, requestId?: string, extra?: Record<string, unknown>) => Response;
export declare const readJson: <T>(request: Request, maxBytes?: number) => Promise<T>;
export declare class Router<S> {
    #private;
    add(method: HttpMethod, path: string, handler: Handler<S>): this;
    get(path: string, handler: Handler<S>): this;
    post(path: string, handler: Handler<S>): this;
    delete(path: string, handler: Handler<S>): this;
    handle(request: Request, services: S): Promise<Response>;
}
