import { test, expect } from "@playwright/test";
import { wrapWithCsp } from "../../../src/shared/mcp-app-csp.js";

type CspProbeResult = {
  allowed: "ok" | "blocked";
  blocked: "ok" | "blocked";
};

test("MCP App metadata CSP allows declared connect-src and blocks undeclared hosts", async ({ page }) => {
  let blockedRouteHits = 0;

  await page.route("https://allowed.example.com/**", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    }),
  );
  await page.route("https://blocked.example.com/**", (route) => {
    blockedRouteHits += 1;
    return route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      body: "should-not-be-requested",
    });
  });

  const probeHtml = `
<!doctype html>
<html>
<head></head>
<body>
<script>
(async () => {
  const result = { allowed: "blocked", blocked: "ok" };
  try {
    await fetch("https://allowed.example.com/ok");
    result.allowed = "ok";
  } catch {}
  try {
    await fetch("https://blocked.example.com/ok");
  } catch {
    result.blocked = "blocked";
  }
  window.parent.postMessage({ type: "mcp-app-csp-result", result }, "*");
})();
</script>
</body>
</html>`;

  // Spec shape: domain BUCKETS, not directive names. `connectDomains` → connect-src.
  // (The old host type was keyed `connectSrc`, so a conformant server's
  // `connectDomains` was silently dropped and its network access denied.)
  const wrapped = wrapWithCsp(probeHtml, {
    connectDomains: ["https://allowed.example.com"],
  });
  const frameUrl = `data:text/html;charset=utf-8,${encodeURIComponent(wrapped)}`;

  await page.setContent(`
<script>
window.__mcpAppCspResult = null;
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "mcp-app-csp-result") {
    window.__mcpAppCspResult = event.data.result;
  }
});
</script>
<iframe title="MCP App" src="${frameUrl}"></iframe>`);

  const result = await page
    .waitForFunction(() => window.__mcpAppCspResult, undefined, { timeout: 10_000 })
    .then((handle) => handle.jsonValue() as Promise<CspProbeResult>);

  expect(result).toEqual({
    allowed: "ok",
    blocked: "blocked",
  });
  expect(blockedRouteHits).toBe(0);
});
