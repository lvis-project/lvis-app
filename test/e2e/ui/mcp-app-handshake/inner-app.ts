/**
 * The INNER app — a stock ext-apps guest. This is the whole point of the test:
 * it is COMPLETELY UNMODIFIED. No custom transport, no shim, no LVIS import.
 *
 * `app.connect()` with no argument uses ext-apps' default transport, which is
 * `new PostMessageTransport(window.parent, window.parent)`. In a bare <webview>
 * that would post to ITSELF (window.parent === window) and deadlock — that is
 * exactly why the old hand-rolled bridge was dead. Here it runs inside the
 * sandbox-proxy's inner iframe, so `window.parent` is a real, different,
 * opaque-origin frame and the handshake completes.
 *
 * Diagnostics go to console (captured by the test main). They must NOT go over
 * postMessage: the relay correctly drops non-JSON-RPC frames, and polluting the
 * protocol stream is precisely what we don't want to prove.
 */
import { App } from "@modelcontextprotocol/ext-apps";

console.log(`E2E_INNER PARENT_IS_SELF:${window.parent === window}`);

const app = new App({ name: "e2e-inner-app", version: "1.0.0" }, {});

app
  .connect()
  .then(() => console.log("E2E_INNER INNER_CONNECTED"))
  .catch((err: unknown) => console.log(`E2E_INNER INNER_CONNECT_FAILED:${String(err)}`));
