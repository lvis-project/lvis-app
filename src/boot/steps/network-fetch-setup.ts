/**
 * Boot step — network fetch surface (§4.2, extracted from boot.ts C18).
 *
 * Builds the Electron-backed fetch implementations the rest of boot threads
 * around: the plain network-stack fetch and the SSRF-guarded LLM fetch.
 */
import { net } from "electron";
import { Readable } from "node:stream";
import { createSafeLlmFetch } from "../../main/safe-llm-fetch.js";
import type { BootContext } from "../context.js";
import { REDIRECT_STATUSES } from "../../main/host-fetch-guard.js";

export async function setupNetworkFetch(ctx: BootContext): Promise<void> {
  const electronNetFetch = net.fetch.bind(net);
  const createElectronFetch = (fetchImpl: typeof electronNetFetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const normalizedInput = input instanceof URL ? input.toString() : input;
      return fetchImpl(normalizedInput as string | Request, {
        ...(init ?? {}),
        bypassCustomProtocolHandlers: true,
      });
    }) as typeof fetch;
  const networkFetch = createElectronFetch(electronNetFetch);
  const llmFetch = createSafeLlmFetch(electronNetFetch);

  ctx.networkFetch = networkFetch;
  ctx.singleHopNetworkFetch = createSingleHopFetch();
  ctx.llmFetch = llmFetch;
}

/**
 * A fetch that takes EXACTLY ONE hop, on Chromium's stack.
 *
 * This is the transport under `hostApi.hostFetch`, and it exists because
 * `net.fetch` offers no mode in which the HOST stays in control of a redirect:
 * `follow` follows before any gate can look at the next URL, and `manual` and
 * `error` both throw — measured, not read off the docs ("Redirect was
 * cancelled" / "Attempted to redirect, but redirect policy was 'error'"). The
 * one mode that makes no further request and reports where the server pointed
 * is the mode that API does not have. `net.request({ redirect: "manual" })`
 * does have it: its `redirect` event carries the status, the resolved next URL
 * and the response headers, and aborting inside the handler cancels the hop.
 *
 * So this wrapper materializes a redirect as an ordinary `Response` — status,
 * `location` and the rest of the headers, no body — and NEVER follows one.
 * Whether a next hop happens is its caller's decision (`runHostFetchHops` for
 * `hostApi.hostFetch`, `fetchPublicHttpResponse` for host-initiated egress);
 * both re-run their gate per hop. `init.redirect` is deliberately ignored: a
 * transport that could be talked into following would put the gate back where
 * `net.fetch` had it, behind the first request only.
 *
 * Kept on Chromium's stack rather than Node's on purpose, and that is what
 * makes it the transport for HOST egress too: Chromium resolves the machine's
 * proxy configuration and reads the OS trust store, while Node's `fetch` knows
 * neither. A host request issued on Node's stack goes direct on a machine whose
 * configuration says otherwise — a path the user never chose, and one that on
 * an intercepted network cannot complete at all.
 *
 * Its behaviour was verified in a REAL Electron main (vitest under this repo
 * runs as Node, where `electron.net` is undefined) — a 302 comes back as a
 * Response with the resolved location, a relative Location arrives resolved,
 * method/headers/body pass through, and an aborted signal rejects with
 * AbortError.
 */
function createSingleHopFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      input instanceof URL ? input.toString()
      : typeof input === "string" ? input
      : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    return await new Promise<Response>((resolve, reject) => {
      // One settlement, whichever event arrives first. `abort()` inside the
      // redirect handler makes a later `error` event ordinary, not a failure.
      let settled = false;
      const settle = <T>(fn: (v: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const request = net.request({ url, method, redirect: "manual" });
      const requestHeaders = new Headers((init?.headers as HeadersInit | undefined) ?? {});
      requestHeaders.forEach((value, key) => request.setHeader(key, value));
      const signal = init?.signal ?? undefined;
      const onAbort = (): void => {
        request.abort();
        settle(reject, new DOMException("This operation was aborted", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      request.on("redirect", (statusCode, _method, redirectUrl, responseHeaders) => {
        // Cancel the hop, keep the answer. The synthesized Response carries the
        // server's own headers; `location` is set from the RESOLVED URL when the
        // server sent a relative one, so the caller never re-resolves.
        request.abort();
        const headers = new Headers();
        for (const [key, value] of Object.entries(responseHeaders)) {
          for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
        }
        headers.set("location", redirectUrl);
        settle(resolve, new Response(null, { status: statusCode, headers }));
      });
      request.on("response", (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
        }
        const status = response.statusCode;
        // A 3xx can arrive HERE too (net emits `redirect` only when it would
        // have followed; a 304 lands as a response). Body rules per fetch: null
        // body statuses and HEAD carry none.
        const bodyless =
          status === 204 || status === 205 || status === 304 || method === "HEAD"
          || REDIRECT_STATUSES.has(status);
        const body = bodyless
          ? null
          : (Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>);
        settle(
          resolve,
          new Response(body, {
            status,
            statusText: response.statusMessage ?? "",
            headers,
          }),
        );
      });
      request.on("error", (error) => settle(reject, error));
      const body = init?.body ?? null;
      if (body === null) {
        request.end();
      } else if (typeof body === "string") {
        request.end(Buffer.from(body));
      } else if (body instanceof Uint8Array) {
        request.end(Buffer.from(body));
      } else if (body instanceof ArrayBuffer) {
        request.end(Buffer.from(body));
      } else if (body instanceof URLSearchParams) {
        requestHeaders.has("content-type")
          || request.setHeader("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
        request.end(Buffer.from(body.toString()));
      } else if (typeof (body as ReadableStream).getReader === "function") {
        void (async () => {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            request.write(Buffer.from(value));
          }
          request.end();
        })().catch((error: unknown) => {
          request.abort();
          settle(reject, error instanceof Error ? error : new Error(String(error)));
        });
      } else {
        // FormData/Blob would need multipart assembly this transport does not
        // do. Refusing loudly beats sending a body the server cannot parse.
        request.abort();
        settle(
          reject,
          new TypeError("hostFetch transport: unsupported body type (use string/bytes/stream)"),
        );
      }
    });
  }) as typeof fetch;
}
