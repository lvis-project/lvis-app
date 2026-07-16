import {
  A2A_REMOTE_MAX_ROUTE_BYTES,
  A2A_REMOTE_ROUTE_TIMEOUT_MS,
  parseAgentHubRouteSnapshot,
  toAgentHubRouteResolveRequest,
  type A2ARemoteTransport,
  type A2ARouteControlPlaneClient,
  type A2ARouteResolveRequest,
  type A2ARouteSnapshot,
} from "./a2a-remote-contracts.js";
import { parseA2AStrictJson } from "./a2a-strict-json.js";
import { createA2AStrictTransport } from "./a2a-remote-transport.js";

const RESOLVE_PATH = "/api/v1/a2a/routes/resolve";

export interface A2AAgentHubAuthHandle { take(): string; zeroize(): void; }
export interface A2AAgentHubAuthResolver { prepare(): Promise<A2AAgentHubAuthHandle>; }
export interface CreateA2AAgentHubClientOptions {
  baseUrl: string;
  authResolver: A2AAgentHubAuthResolver;
  /** Host-owned test seam. Production leaves this unset for the strict transport. */
  transport?: A2ARemoteTransport;
  now?: () => number;
}

function hubResolveUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("a2a-agent-hub-url-invalid");
  return new URL(RESOLVE_PATH, url).toString();
}

export class A2AAgentHubClient implements A2ARouteControlPlaneClient {
  private readonly resolveUrl: string;
  private readonly transport: A2ARemoteTransport;
  private readonly now: () => number;

  constructor(private readonly options: CreateA2AAgentHubClientOptions) {
    this.resolveUrl = hubResolveUrl(options.baseUrl);
    this.transport = options.transport ?? createA2AStrictTransport({ maxResponseBytes: A2A_REMOTE_MAX_ROUTE_BYTES });
    this.now = options.now ?? Date.now;
  }

  async resolve(input: Readonly<A2ARouteResolveRequest>): Promise<A2ARouteSnapshot> {
    const body = Buffer.from(JSON.stringify(toAgentHubRouteResolveRequest(input)), "utf8");
    if (body.byteLength > A2A_REMOTE_MAX_ROUTE_BYTES) throw new Error("a2a-agent-hub-request-too-large");
    const auth = await this.options.authResolver.prepare();
    try {
      const response = await this.transport.invoke({ url: this.resolveUrl, body, bearer: auth.take(), activateExactReplay: false, plane: "control", timeoutMs: A2A_REMOTE_ROUTE_TIMEOUT_MS });
      return parseAgentHubRouteSnapshot({ status: response.status, headers: response.headers, body: parseA2AStrictJson(response.body, { maxBytes: A2A_REMOTE_MAX_ROUTE_BYTES }) }, input, this.now());
    } finally { auth.zeroize(); body.fill(0); }
  }
}
