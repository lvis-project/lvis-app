import {
  A2A_REMOTE_MAX_ROUTE_BYTES,
  A2A_REMOTE_ROUTE_TIMEOUT_MS,
  parseA2ARouteSnapshot,
  toA2ARouteResolveRequest,
  type A2ARemoteTransport,
  type A2ARouteControlPlaneClient,
  type A2ARouteResolveRequest,
  type A2ARouteSnapshot,
} from "./a2a-remote-contracts.js";
import { parseA2AStrictJson } from "./a2a-strict-json.js";
import { createA2AStrictTransport } from "./a2a-remote-transport.js";

const RESOLVE_PATH = "/api/v1/a2a/routes/resolve";

export interface A2ARouteControlAuthHandle { take(): string; zeroize(): void; }
export interface A2ARouteControlAuthResolver { prepare(): Promise<A2ARouteControlAuthHandle>; }
export interface CreateA2ARouteControlClientOptions {
  baseUrl: string;
  authResolver: A2ARouteControlAuthResolver;
  /** Host-owned test seam. Production leaves this unset for the strict transport. */
  transport?: A2ARemoteTransport;
  now?: () => number;
}

function routeControlResolveUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("a2a-route-control-url-invalid");
  return new URL(RESOLVE_PATH, url).toString();
}

export class A2ARouteControlClient implements A2ARouteControlPlaneClient {
  private readonly resolveUrl: string;
  private readonly transport: A2ARemoteTransport;
  private readonly now: () => number;

  constructor(private readonly options: CreateA2ARouteControlClientOptions) {
    this.resolveUrl = routeControlResolveUrl(options.baseUrl);
    this.transport = options.transport ?? createA2AStrictTransport({ maxResponseBytes: A2A_REMOTE_MAX_ROUTE_BYTES });
    this.now = options.now ?? Date.now;
  }

  async resolve(input: Readonly<A2ARouteResolveRequest>): Promise<A2ARouteSnapshot> {
    const body = Buffer.from(JSON.stringify(toA2ARouteResolveRequest(input)), "utf8");
    if (body.byteLength > A2A_REMOTE_MAX_ROUTE_BYTES) throw new Error("a2a-route-control-request-too-large");
    const auth = await this.options.authResolver.prepare();
    try {
      const response = await this.transport.invoke({ url: this.resolveUrl, body, bearer: auth.take(), activateExactReplay: false, plane: "control", timeoutMs: A2A_REMOTE_ROUTE_TIMEOUT_MS });
      return parseA2ARouteSnapshot({ status: response.status, headers: response.headers, body: parseA2AStrictJson(response.body, { maxBytes: A2A_REMOTE_MAX_ROUTE_BYTES }) }, input, this.now());
    } finally { auth.zeroize(); body.fill(0); }
  }
}
