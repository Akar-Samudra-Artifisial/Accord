import api, { type Route } from '@forge/api';

/** Who the request runs as. `user` only works where Forge has a user context (resolvers). */
export type Principal = 'app' | 'user';

export class AtlassianApiError extends Error {
  constructor(
    readonly product: 'jira' | 'confluence',
    readonly status: number,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${product} ${path} failed with HTTP ${status}: ${detail.slice(0, 400)}`);
    this.name = 'AtlassianApiError';
  }
}

interface JsonRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  as?: Principal;
}

async function send<T>(product: 'jira' | 'confluence', path: Route, request: JsonRequest): Promise<T> {
  const client = request.as === 'user' ? api.asUser() : api.asApp();
  const init = {
    method: request.method ?? 'GET',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  };
  const response =
    product === 'jira' ? await client.requestJira(path, init) : await client.requestConfluence(path, init);
  const text = await response.text();
  if (!response.ok) {
    throw new AtlassianApiError(product, response.status, path.value, text);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export function jira<T>(path: Route, request: JsonRequest = {}): Promise<T> {
  return send<T>('jira', path, request);
}

export function confluence<T>(path: Route, request: JsonRequest = {}): Promise<T> {
  return send<T>('confluence', path, request);
}

/** True when the error is an HTTP 404 from a product API. */
export function isNotFound(error: unknown): boolean {
  return error instanceof AtlassianApiError && error.status === 404;
}
