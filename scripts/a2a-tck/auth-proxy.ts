import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

const CARD_PATH = "/.well-known/agent-card.json";
const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "content-encoding",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface A2ATckAuthProxy {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface StartA2ATckAuthProxyOptions {
  targetUrl: string;
  secret: string;
  host?: string;
  port?: number;
}

function requestHeaders(source: IncomingHttpHeaders, secret: string): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(source)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value);
    } else {
      headers.set(name, raw);
    }
  }
  headers.set("authorization", "Bearer " + secret);
  return headers;
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overCap = false;
    req.on("data", (chunk: Buffer) => {
      if (overCap) return;
      total += chunk.length;
      if (total > MAX_PROXY_BODY_BYTES) {
        overCap = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overCap) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function responseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}

function upstreamUrl(targetUrl: string, requestPath: string): string | undefined {
  if (requestPath === CARD_PATH) return targetUrl.replace(/\/$/, "") + CARD_PATH;
  if (requestPath === "/" || requestPath === "") return targetUrl;
  return undefined;
}

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: StartA2ATckAuthProxyOptions,
  publicUrl: string,
): Promise<void> {
  const parsed = new URL(req.url ?? "/", publicUrl);
  const target = upstreamUrl(options.targetUrl, parsed.pathname);
  if (!target) {
    sendJson(res, 404, { ok: false, error: "not-found" });
    return;
  }

  const method = req.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
  if (body === null) {
    sendJson(res, 413, { ok: false, error: "payload-too-large" });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref();
  try {
    const upstream = await fetch(target + parsed.search, {
      method,
      headers: requestHeaders(req.headers, options.secret),
      ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
      redirect: "manual",
      signal: controller.signal,
    });

    if (parsed.pathname === CARD_PATH && upstream.ok) {
      const card = (await upstream.json()) as Record<string, unknown>;
      if (Array.isArray(card.supportedInterfaces)) {
        card.supportedInterfaces = card.supportedInterfaces.map((entry) =>
          typeof entry === "object" && entry !== null
            ? { ...(entry as Record<string, unknown>), url: publicUrl }
            : entry,
        );
      }
      res.writeHead(upstream.status, {
        ...responseHeaders(upstream),
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(card));
      return;
    }

    const headers = responseHeaders(upstream);
    res.writeHead(upstream.status, headers);
    if (!upstream.body) {
      res.end();
      return;
    }
    if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      Readable.fromWeb(upstream.body as never).pipe(res);
      return;
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } finally {
    clearTimeout(timeout);
  }
}

export function startA2ATckAuthProxy(
  options: StartA2ATckAuthProxyOptions,
): Promise<A2ATckAuthProxy> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  let publicUrl = "";
  const server: Server = createServer((req, res) => {
    void proxyRequest(req, res, options, publicUrl).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: "upstream-failed" });
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      const boundPort = address?.port ?? 0;
      publicUrl = "http://" + host + ":" + String(boundPort);
      resolve({
        port: boundPort,
        url: publicUrl,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections();
            server.close((error) => {
              if (!error || (error as { code?: string }).code === "ERR_SERVER_NOT_RUNNING") {
                closeResolve();
                return;
              }
              closeReject(error);
            });
          }),
      });
    });
  });
}