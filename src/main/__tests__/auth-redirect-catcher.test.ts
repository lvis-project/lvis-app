/**
 * The host-owned loopback redirect catcher, driven against a REAL listener.
 *
 * These cases open actual sockets and speak actual HTTP to them, because every
 * property worth having here is a property of the socket: which interface it
 * binds, what it answers a forged request, whether a second open can steal the
 * first one's port. A mock of `node:http` would assert the shape of the calls
 * this module makes and none of that.
 */
import { describe, expect, it, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
import { AuthRedirectCatchers } from "../auth-redirect-catcher.js";

const OWNER = "ms-graph";
const OTHER_OWNER = "meeting";

const openCatchers: Array<{ catchers: AuthRedirectCatchers; owner: string; handle: string }> = [];

afterEach(() => {
  while (openCatchers.length > 0) {
    const entry = openCatchers.pop();
    if (entry !== undefined) entry.catchers.close(entry.owner, entry.handle);
  }
});

async function open(
  catchers: AuthRedirectCatchers,
  owner = OWNER,
): Promise<{ handle: string; redirectUri: string }> {
  const result = await catchers.open(owner);
  openCatchers.push({ catchers, owner, handle: result.handle });
  return result;
}

/** One request to the catcher, with full control over the line the server sees. */
function hit(
  redirectUri: string,
  path: string,
  options: { method?: string; hostHeader?: string } = {},
): Promise<{ status: number; location: string | undefined; body: string }> {
  const { port } = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(port),
        path,
        method: options.method ?? "GET",
        headers:
          options.hostHeader === undefined ? {} : { host: options.hostHeader },
        // The catcher answers the redirect with a 303 to itself; following it
        // here would collapse the two responses this suite wants to tell apart.
        setHost: options.hostHeader === undefined,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the listener it binds", () => {
  it("binds loopback and reports the URI by HOST NAME, not by address", async () => {
    const catchers = new AuthRedirectCatchers();
    const { redirectUri } = await open(catchers);
    // `localhost`, not `127.0.0.1`. Identity providers register loopback
    // redirect URIs by host and allow any port; the other spelling is a
    // DIFFERENT redirect URI and the provider rejects it. This is the one
    // detail that decides whether a real sign-in works at all.
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/u);
    expect(Number(new URL(redirectUri).port)).toBeGreaterThan(0);
  });

  it("refuses a second open for the same plugin rather than replacing the first", async () => {
    const catchers = new AuthRedirectCatchers();
    const first = await open(catchers);
    await expect(catchers.open(OWNER)).rejects.toThrow(/already open/u);
    // The first is still live: replacing it would have stranded a sign-in
    // already in flight, whose redirect would then arrive at a closed port
    // AFTER the user had typed their password.
    await expect(hit(first.redirectUri, "/")).resolves.toMatchObject({ status: 200 });
  });

  it("lets a different plugin open its own, on its own port", async () => {
    const catchers = new AuthRedirectCatchers();
    const mine = await open(catchers, OWNER);
    const theirs = await open(catchers, OTHER_OWNER);
    expect(theirs.redirectUri).not.toBe(mine.redirectUri);
  });
});

describe("what it accepts", () => {
  it("resolves the wait with the redirect's query parameters", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    const waiting = catchers.wait(OWNER, handle);
    await hit(redirectUri, "/?code=abc123&state=xyz");
    await expect(waiting).resolves.toEqual({ code: "abc123", state: "xyz" });
  });

  it("resolves a wait that arrives AFTER the redirect did", async () => {
    // The browser can land before the caller gets around to waiting. A wait
    // that only ever watched for a future arrival would hang on exactly the
    // fast path, and the hang would look like a user who never signed in.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    await hit(redirectUri, "/?code=early");
    await expect(catchers.wait(OWNER, handle)).resolves.toEqual({ code: "early" });
  });

  it("sends the browser away from the URL that carries the code", async () => {
    // A 303 back to the bare URI, so the authorization code does not sit in
    // the user's history. The page they end up looking at is the landing page.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    const waiting = catchers.wait(OWNER, handle);
    const response = await hit(redirectUri, "/?code=abc123");
    expect(response.status).toBe(303);
    expect(response.location).toBe(redirectUri);
    expect(response.body).not.toContain("abc123");
    await waiting;
  });

  it("serves the host's own page, never markup the caller supplied", async () => {
    const catchers = new AuthRedirectCatchers();
    const { redirectUri } = await open(catchers);
    const landing = await hit(redirectUri, "/");
    expect(landing.status).toBe(200);
    expect(landing.body).toContain("Sign-in complete");
    // There is no parameter through which a caller could reach this body. The
    // absence is the point: a caller-supplied template would be plugin markup
    // rendered by the user's browser on a loopback origin.
  });
});

describe("what it refuses", () => {
  it("refuses a non-GET request", async () => {
    const catchers = new AuthRedirectCatchers();
    const { redirectUri } = await open(catchers);
    await expect(hit(redirectUri, "/?code=x", { method: "POST" })).resolves.toMatchObject({
      status: 405,
    });
  });

  it("refuses a request whose Host header is not loopback", async () => {
    // The listener is bound to 127.0.0.1, so a remote host cannot reach it —
    // but a page in the user's own browser can, and DNS rebinding makes a name
    // that resolves to 127.0.0.1 look same-origin. The `state` check downstream
    // is what actually defeats a forged code; this is the cheap half.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    let settled = false;
    void catchers.wait(OWNER, handle).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const response = await hit(redirectUri, "/?code=forged", {
      hostHeader: "attacker.example.com",
    });
    expect(response.status).toBe(400);
    // And it did not resolve the wait, which is the part that would have
    // mattered: a 400 that still handed the code to the plugin would be worse
    // than no check at all.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  });

  it("reports another plugin's handle as unknown rather than as forbidden", async () => {
    // Telling the two apart would let a plugin probe for another plugin's live
    // sign-in — a side channel opened by an error message.
    const catchers = new AuthRedirectCatchers();
    const { handle } = await open(catchers, OWNER);
    await expect(catchers.wait(OTHER_OWNER, handle)).rejects.toThrow(
      /unknown redirect-catcher handle/u,
    );
    await expect(
      catchers.wait(OTHER_OWNER, "8f1c2e5a-0000-4000-8000-aaaaaaaaaaaa"),
    ).rejects.toThrow(/unknown redirect-catcher handle/u);
  });

  it("refuses a timeout outside its bounds instead of clamping it", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle } = await open(catchers);
    await expect(catchers.wait(OWNER, handle, 1)).rejects.toThrow(/timeoutMs must be between/u);
    await expect(catchers.wait(OWNER, handle, Number.NaN)).rejects.toThrow(/finite/u);
  });

  it("closes the listener when the wait times out", async () => {
    // A port left bound after the caller stopped waiting is a listener nobody
    // owns, and the owner slot it holds would refuse the user's next attempt.
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers);
    await expect(catchers.wait(OWNER, handle, 5_000 /* min */)).rejects.toThrow(
      /no redirect received/u,
    );
    await expect(hit(redirectUri, "/")).rejects.toThrow();
    // ...and the slot is free again.
    await expect(open(catchers)).resolves.toBeDefined();
  }, 15_000);
});

describe("closing", () => {
  it("rejects a pending wait and frees the owner slot", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle } = await open(catchers);
    const waiting = catchers.wait(OWNER, handle);
    catchers.close(OWNER, handle);
    await expect(waiting).rejects.toThrow(/was closed/u);
    await expect(open(catchers)).resolves.toBeDefined();
  });

  it("ignores a close from a plugin that does not own the handle", async () => {
    const catchers = new AuthRedirectCatchers();
    const { handle, redirectUri } = await open(catchers, OWNER);
    catchers.close(OTHER_OWNER, handle);
    await expect(hit(redirectUri, "/")).resolves.toMatchObject({ status: 200 });
  });

  it("is idempotent, including for a handle that never existed", () => {
    const catchers = new AuthRedirectCatchers();
    expect(() => catchers.close(OWNER, "no-such-handle")).not.toThrow();
  });
});
