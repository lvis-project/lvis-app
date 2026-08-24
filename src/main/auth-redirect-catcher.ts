/**
 * Host-owned loopback catcher for an OAuth authorization-code redirect.
 *
 * WHY THIS IS A HOST CAPABILITY AND NOT A PLUGIN'S OWN SOCKET. A plugin that
 * signs a user in with the authorization-code flow needs something listening at
 * the redirect URI. In-process it just called `http.createServer` itself. A
 * confined plugin child cannot: on macOS the Seatbelt profile emits
 * `network-bind` only under a flag this app never sets, so `listen()` is
 * refused; on Linux the child runs under `--unshare-net`, so `listen()`
 * SUCCEEDS into a private loopback the user's browser is not in — and the flow
 * then hangs AFTER the user has typed their password. A refusal that arrives
 * post-authentication as a hang is the worst shape available, which is why the
 * listener moves to the host rather than the fence being loosened.
 *
 * WHY NOT `openAuthWindow`. It already opens a window and returns the URL that
 * matched `completionUrlPatterns`, which looks like the same thing. It is not:
 * completion is checked on `did-navigate` and deliberately NOT on
 * `will-redirect` ("pre-commit redirect intent — not yet observed by server"),
 * so catching a redirect to a port where nothing listens would rest on
 * Chromium committing an error page for a refused connection. It would also
 * serve no response, and the identity provider's flow expects one. Depending on
 * error-page commit semantics for a credential path is the kind of thing that
 * works until a Chromium upgrade, so this serves the redirect for real.
 *
 * WHAT THE PLUGIN NEVER GETS. The handle names a listener; it is not the
 * listener. The plugin cannot choose the interface, the port, the response
 * body, or the request shape it accepts, and it receives the query parameters
 * ALONE — not headers, not the path, not the body. In particular the response
 * page is the host's: a caller-supplied success/error template would be plugin
 * markup rendered by the user's browser on a loopback origin, which is a
 * capability nobody asked for.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";

/**
 * Bounds. Each is a refusal rather than a truncation: a request that exceeds
 * one is not a well-formed redirect from an identity provider, and treating it
 * as one that merely needs trimming would be a guess about a credential path.
 */
const MAX_QUERY_PARAMS = 32;
const MAX_PARAM_NAME_LENGTH = 128;
const MAX_PARAM_VALUE_LENGTH = 8192;
/** A request line long enough to be an attack rather than a redirect. */
const MAX_REQUEST_URL_LENGTH = 16 * 1024;

const DEFAULT_AUTH_REDIRECT_TIMEOUT_MS = 5 * 60_000;
const MIN_AUTH_REDIRECT_TIMEOUT_MS = 5_000;
const MAX_AUTH_REDIRECT_TIMEOUT_MS = 15 * 60_000;

/** The parsed redirect. Query parameters only — see the file header. */
export type AuthRedirectParams = Readonly<Record<string, string>>;

export interface AuthRedirectOpenResult {
  handle: string;
  /**
   * `http://localhost:<port>`. The SHAPE matters: identity providers register
   * loopback redirect URIs by host, allowing any port, and MSAL's own default
   * client builds exactly this string. Returning `127.0.0.1` instead would be
   * a different registered URI and would be rejected by the provider.
   */
  redirectUri: string;
}

interface LiveCatcher {
  handle: string;
  ownerKey: string;
  redirectUri: string;
  server: Server;
  /** Set once the redirect arrives; read by a `wait` that comes in after it. */
  received: AuthRedirectParams | null;
  waiters: Array<{
    resolve: (params: AuthRedirectParams) => void;
    reject: (err: Error) => void;
  }>;
  closed: boolean;
}

function successPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Sign-in complete</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
<h2 style="color:#60a5fa">Sign-in complete</h2>
<p>You can close this window and return to the app.</p>
</body></html>`;
}

/**
 * Whether the request's `Host` header names the loopback interface.
 *
 * The listener is bound to 127.0.0.1, so a remote host cannot reach it — but a
 * PAGE in the user's own browser can, at any origin, and a forged
 * `?code=&state=` delivered that way would be indistinguishable from the real
 * redirect at this layer. The `state` check downstream is what actually defeats
 * that; refusing a non-loopback `Host` is the cheap half that also blocks
 * DNS-rebinding, where a name that resolves to 127.0.0.1 makes the browser
 * treat the listener as same-origin.
 */
function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  const withoutPort = hostHeader.replace(/:\d+$/, "").toLowerCase();
  return (
    withoutPort === "localhost" || withoutPort === "127.0.0.1" || withoutPort === "[::1]"
  );
}

/**
 * Parse the redirect's query string, refusing anything outside the bounds.
 * Returns `null` when there is nothing to report yet — a bare `/` is the
 * landing page the 303 below sends the browser to, not a redirect.
 */
function parseRedirectParams(requestUrl: string, base: string): AuthRedirectParams | null {
  if (requestUrl.length > MAX_REQUEST_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(requestUrl, base);
  } catch {
    return null;
  }
  const entries = [...parsed.searchParams.entries()];
  if (entries.length === 0) return null;
  if (entries.length > MAX_QUERY_PARAMS) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.length > MAX_PARAM_NAME_LENGTH) return null;
    if (value.length > MAX_PARAM_VALUE_LENGTH) return null;
    // Last write wins, matching `URLSearchParams.get` — a repeated parameter is
    // malformed rather than meaningful, and picking a rule beats picking one
    // per reader.
    out[name] = value;
  }
  return Object.freeze(out);
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_AUTH_REDIRECT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) {
    throw new Error("authRedirect.wait: timeoutMs must be a finite number");
  }
  if (timeoutMs < MIN_AUTH_REDIRECT_TIMEOUT_MS || timeoutMs > MAX_AUTH_REDIRECT_TIMEOUT_MS) {
    throw new Error(
      `authRedirect.wait: timeoutMs must be between ${MIN_AUTH_REDIRECT_TIMEOUT_MS} and ${MAX_AUTH_REDIRECT_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

/**
 * The registry of live catchers, keyed by owner.
 *
 * ONE PER OWNER, and the second `open` is refused rather than replacing the
 * first. Replacing would strand a sign-in already in flight — its redirect
 * would arrive at a closed port after the user had authenticated — which is the
 * same post-authentication failure this whole capability exists to avoid.
 * MSAL's own client refuses a second listen for the same reason.
 */
export class AuthRedirectCatchers {
  private readonly byHandle = new Map<string, LiveCatcher>();
  private readonly byOwner = new Map<string, string>();

  async open(ownerKey: string): Promise<AuthRedirectOpenResult> {
    if (this.byOwner.has(ownerKey)) {
      throw new Error(
        "authRedirect.open: a redirect catcher is already open for this plugin; close it before opening another",
      );
    }
    const handle = randomUUID();
    // Reserve the owner slot BEFORE the await. Two concurrent `open` calls
    // would otherwise both pass the check above and both bind.
    this.byOwner.set(ownerKey, handle);
    try {
      const server = createServer();
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as AddressInfo | string | null;
          if (address === null || typeof address === "string") {
            reject(new Error("authRedirect.open: loopback listener reported no port"));
            return;
          }
          resolve(address.port);
        });
      });
      const redirectUri = `http://localhost:${port}`;
      const catcher: LiveCatcher = {
        handle,
        ownerKey,
        redirectUri,
        server,
        received: null,
        waiters: [],
        closed: false,
      };
      server.on("request", (req, res) => this.onRequest(catcher, req, res));
      // A live listener must not hold the app open at quit.
      server.unref();
      this.byHandle.set(handle, catcher);
      return { handle, redirectUri };
    } catch (err) {
      this.byOwner.delete(ownerKey);
      throw err;
    }
  }

  private onRequest(catcher: LiveCatcher, req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" });
      res.end();
      return;
    }
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(400);
      res.end();
      return;
    }
    const params = parseRedirectParams(req.url ?? "/", catcher.redirectUri);
    if (params === null) {
      // The landing page: the browser followed the 303 below, or the provider
      // sent the user here with nothing to report.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(successPage());
      return;
    }
    // Redirect the browser to the bare URI so the authorization code does not
    // remain in history. The response the USER ends up looking at is the
    // landing page above.
    res.writeHead(303, { location: catcher.redirectUri });
    res.end();
    if (catcher.received !== null) return; // single-use; a replay changes nothing
    catcher.received = params;
    const waiters = catcher.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(params);
  }

  /**
   * Resolve with the redirect's query parameters.
   *
   * Resolves immediately when the redirect already arrived, which is not a
   * nicety: the browser can land before the caller gets around to waiting, and
   * a wait that only ever watched for a FUTURE arrival would hang on exactly
   * the fast path.
   */
  async wait(
    ownerKey: string,
    handle: string,
    timeoutMs?: number,
  ): Promise<AuthRedirectParams> {
    const catcher = this.requireOwned(ownerKey, handle, "wait");
    if (catcher.received !== null) return catcher.received;
    const boundedTimeoutMs = normalizeTimeoutMs(timeoutMs);
    return await new Promise<AuthRedirectParams>((resolve, reject) => {
      const waiter = {
        resolve: (params: AuthRedirectParams) => {
          clearTimeout(timer);
          resolve(params);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const index = catcher.waiters.indexOf(waiter);
        if (index >= 0) catcher.waiters.splice(index, 1);
        // Close on timeout. Leaving the port bound after the caller stopped
        // waiting is a listener nobody owns, and the owner slot it holds would
        // refuse the user's next attempt.
        this.close(ownerKey, handle);
        reject(new Error(`authRedirect.wait: no redirect received within ${boundedTimeoutMs}ms`));
      }, boundedTimeoutMs);
      catcher.waiters.push(waiter);
    });
  }

  /** Release the listener. Idempotent — a close of an unknown handle is a no-op. */
  close(ownerKey: string, handle: string): void {
    const catcher = this.byHandle.get(handle);
    if (catcher === undefined) return;
    if (catcher.ownerKey !== ownerKey) return;
    if (catcher.closed) return;
    catcher.closed = true;
    this.byHandle.delete(handle);
    if (this.byOwner.get(ownerKey) === handle) this.byOwner.delete(ownerKey);
    const waiters = catcher.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error("authRedirect: the redirect catcher was closed"));
    }
    catcher.server.close();
    catcher.server.closeAllConnections?.();
  }

  /** Close every catcher an owner holds. Used when a plugin is unloaded. */
  closeAllFor(ownerKey: string): void {
    const handle = this.byOwner.get(ownerKey);
    if (handle !== undefined) this.close(ownerKey, handle);
  }

  private requireOwned(ownerKey: string, handle: string, member: string): LiveCatcher {
    const catcher = this.byHandle.get(handle);
    // ONE message for "no such handle" and "someone else's handle". Telling the
    // two apart would let a plugin probe for another plugin's live sign-in.
    if (catcher === undefined || catcher.ownerKey !== ownerKey) {
      throw new Error(`authRedirect.${member}: unknown redirect-catcher handle`);
    }
    return catcher;
  }
}
