import { promises as dns } from "node:dns";
import { Agent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import {
  A2A_EXACT_SEND_REPLAY_URI,
  A2A_REMOTE_HTTP_TIMEOUT_MS,
  A2A_REMOTE_MAX_REQUEST_BYTES,
  A2A_REMOTE_MAX_RESPONSE_BYTES,
  type A2ARemoteTransport,
  type A2ARemoteTransportRequest,
  type A2ARemoteTransportResponse,
} from "./a2a-remote-contracts.js";
// One classifier, not two: this transport and the SSRF guard were both
// answering "can a packet to this address leave the machine and arrive?", and
// their two copies had drifted apart on multicast, on reserved space, and on
// every IPv6 address outside global unicast.
import { isGloballyRoutableAddress } from "../core/network-guard.js";

export interface A2ADnsAnswer {
  address: string;
  family: 4 | 6;
}

export interface CreateA2AStrictTransportOptions {
  lookup?: (hostname: string) => Promise<readonly A2ADnsAnswer[]>;
  request?: typeof httpsRequest;
  now?: () => number;
  maxResponseBytes?: number;
  maxHeaderBytes?: number;
}


export function validateA2ARemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("a2a-remote-url-invalid");
  }
  if (
    url.protocol !== "https:"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || !url.hostname
    || isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0
    || url.toString() !== raw
  ) throw new Error("a2a-remote-url-invalid");
  return url;
}

async function defaultLookup(hostname: string): Promise<readonly A2ADnsAnswer[]> {
  const values = await dns.lookup(hostname, { all: true, verbatim: true });
  return values.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

function responseHeaders(rawHeaders: readonly string[]): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]!.toLowerCase();
    const value = rawHeaders[index + 1] ?? "";
    if (headers[key] !== undefined) throw new Error("a2a-remote-duplicate-response-header");
    headers[key] = value;
  }
  return Object.freeze(headers);
}

class PinnedConnectionError extends Error {
  constructor(message: string, readonly retryableBeforeBodyCommit: boolean) { super(message); }
}

export function createA2AStrictTransport(
  options: CreateA2AStrictTransportOptions = {},
): A2ARemoteTransport {
  const lookup = options.lookup ?? defaultLookup;
  const request = options.request ?? httpsRequest;
  const maxResponseBytes = options.maxResponseBytes ?? A2A_REMOTE_MAX_RESPONSE_BYTES;
  const maxHeaderBytes = options.maxHeaderBytes ?? 16 * 1_024;
  const now = options.now ?? (() => performance.now());
  return Object.freeze({
    async invoke(input: Readonly<A2ARemoteTransportRequest>): Promise<A2ARemoteTransportResponse> {
      const url = validateA2ARemoteUrl(input.url);
      if (input.body.byteLength === 0 || input.body.byteLength > A2A_REMOTE_MAX_REQUEST_BYTES) {
        throw new Error("a2a-remote-request-size-invalid");
      }
      const timeoutMs = input.timeoutMs ?? A2A_REMOTE_HTTP_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > A2A_REMOTE_HTTP_TIMEOUT_MS) {
        throw new Error("a2a-remote-timeout-invalid");
      }
      const body = Buffer.from(input.body);
      try {
      const deadline = now() + timeoutMs;
      const answers = await new Promise<readonly A2ADnsAnswer[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("a2a-remote-dns-timeout")), timeoutMs);
        lookup(url.hostname).then(
          (value) => { clearTimeout(timer); resolve(value); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
      const unique = new Set(answers.map((answer) => `${answer.family}:${answer.address}`));
      if (answers.length === 0 || answers.length > 8 || unique.size !== answers.length || answers.some((answer) =>
        !isGloballyRoutableAddress(answer.address) || answer.family !== isIP(answer.address))) {
        throw new Error("a2a-remote-address-ineligible");
      }
      const plane = input.plane ?? "data";
      const invokePinned = async (pinned: A2ADnsAnswer): Promise<A2ARemoteTransportResponse> => {
        const remainingMs = Math.floor(deadline - now());
        if (remainingMs < 1) throw new Error("a2a-remote-timeout");
        return await new Promise<A2ARemoteTransportResponse>((resolve, reject) => {
        let settled = false;
        let lookupCalls = 0;
        let bodyCommitted = false;
        let deadlineTimer: NodeJS.Timeout | undefined;
        const agent = new Agent({ keepAlive: false, maxSockets: 1 });
        const finishReject = (error: Error): void => {
          if (settled) return;
          settled = true;
          if (deadlineTimer) clearTimeout(deadlineTimer);
          agent.destroy();
          reject(error);
        };
        const req = request({
          protocol: "https:",
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          agent,
          servername: url.hostname,
          minVersion: "TLSv1.2",
          maxHeaderSize: maxHeaderBytes,
          timeout: remainingMs,
          lookup: (_hostname, _lookupOptions, callback) => {
            lookupCalls += 1;
            if (lookupCalls !== 1) {
              callback(new Error("a2a-remote-pinned-lookup-repeated"), "", 4);
              return;
            }
            callback(null, pinned.address, pinned.family);
          },
          headers: {
            host: url.hostname,
            connection: "close",
            accept: "application/json",
            "accept-encoding": "identity",
            "content-type": "application/json",
            "content-length": String(body.byteLength),
            ...(plane === "data" ? { "a2a-version": "1.0" } : { "cache-control": "no-store" }),
            authorization: `Bearer ${input.bearer}`,
            ...(plane === "data" && input.activateExactReplay
              ? { "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI }
              : {}),
          },
        }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            finishReject(new Error("a2a-remote-redirect-rejected"));
            return;
          }
          const contentEncoding = res.headers["content-encoding"];
          if (contentEncoding !== undefined && contentEncoding !== "identity") {
            res.destroy(new Error("a2a-remote-content-encoding-invalid"));
            return;
          }
          const contentType = res.headers["content-type"]?.toLowerCase() ?? "";
          if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
            res.destroy(new Error("a2a-remote-content-type-invalid"));
            return;
          }
          const contentLength = res.headers["content-length"];
          if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxResponseBytes)) {
            res.destroy(new Error("a2a-remote-response-size-invalid"));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > maxResponseBytes) {
              res.destroy(new Error("a2a-remote-response-size-invalid"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", (error) => finishReject(error));
          res.on("end", () => {
            if (settled) return;
            try {
              if (lookupCalls !== 1) throw new Error("a2a-remote-pinned-lookup-invalid");
              const headers = responseHeaders(res.rawHeaders);
              settled = true;
              if (deadlineTimer) clearTimeout(deadlineTimer);
              agent.destroy();
              resolve({ status, headers, body: Uint8Array.from(Buffer.concat(chunks)) });
            } catch (error) {
              finishReject(error instanceof Error ? error : new Error("a2a-remote-response-invalid"));
            }
          });
        });
        deadlineTimer = setTimeout(() => req.destroy(new Error("a2a-remote-timeout")), remainingMs);
        req.once("timeout", () => req.destroy(new Error("a2a-remote-timeout")));
        req.once("error", (error) => finishReject(new PinnedConnectionError(error.message, !bodyCommitted)));
        req.once("socket", (socket) => {
          socket.once("secureConnect", () => {
            if (settled) return;
            // Irreversible data-plane commit fence: set immediately before the
            // first possible body write, not on the later `finish` event.
            bodyCommitted = true;
            req.end(body);
          });
        });
        req.flushHeaders();
        });
      };
      let lastConnectionError: Error | undefined;
      for (const pinned of answers) {
        try {
          return await invokePinned(pinned);
        } catch (error) {
          if (!(error instanceof PinnedConnectionError)) throw error;
          lastConnectionError = error;
          if (plane === "data" && !error.retryableBeforeBodyCommit) throw error;
        }
      }
      throw lastConnectionError ?? new Error("a2a-remote-connect-rejected");
      } finally {
        body.fill(0);
      }
    },
  });
}
