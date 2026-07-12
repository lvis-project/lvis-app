/**
 * The PROBE CARD — a throwaway MCP App that actually CALLS the four spec permissions
 * and reports, per feature, whether it got it.
 *
 * This is the point of the whole exercise. A unit test can only prove the host COMPUTED
 * an allow-list; only running the real APIs inside the real inner frame can prove the
 * browser HONORED it. Each call is wrapped so a rejection is data, not a crash: we want
 * the exact error string, because "did not work" is a legitimate — and expected — result
 * for some of these, and the error is what tells us WHY.
 *
 * Emits one line per feature:
 *   `E2E_PROBE <FEATURE>:ok`            — the API resolved
 *   `E2E_PROBE <FEATURE>:fail:<reason>` — the API rejected/threw (reason = name or message)
 * then `E2E_PROBE DONE`.
 *
 * Runs inside `<iframe sandbox="allow-scripts allow-same-origin" srcdoc>` — the spec's
 * required sandbox pair, so the frame inherits the per-server proxy origin (NON-opaque).
 * That origin is exactly what lets a delegated feature be honored; the probe reports
 * `OPAQUE_ORIGIN:false` to make that fact part of the record.
 */

/**
 * Which card this is — `declared` (the host granted the four features) or `absent` (the
 * resource declared nothing, so every feature must be denied: the fail-closed proof).
 * Injected by the test main into the card HTML; the two cards are otherwise IDENTICAL,
 * which is what makes the comparison meaningful.
 */
const CASE: string = (window as unknown as { __CASE?: string }).__CASE ?? "unknown";

/** Report a feature's outcome. Never throws — a probe that crashes proves nothing. */
async function probe(feature: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(`E2E_PROBE ${CASE} ${feature}:ok`);
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    // The NAME is the load-bearing part (`NotAllowedError` vs `NotFoundError` vs
    // `SecurityError`) — it says WHICH layer refused, and in particular separates
    // "permission denied" from "permission granted but no device/position on this
    // machine". Conflating those two would let a CI box with no webcam masquerade as a
    // working deny.
    const reason = `${e?.name ?? "Error"}|${(e?.message ?? String(err)).replace(/\s+/g, " ").slice(0, 160)}`;
    console.log(`E2E_PROBE ${CASE} ${feature}:fail:${reason}`);
  }
}

async function main(): Promise<void> {
  console.log(`E2E_PROBE ${CASE} OPAQUE_ORIGIN:${window.origin === "null"}`);

  // 1. clipboard-write — navigator.clipboard.writeText
  //
  // `writeText` additionally requires the DOCUMENT TO BE FOCUSED, which is a separate
  // condition from the permission and rejects with the same `NotAllowedError`. The first
  // run of this probe hit exactly that and reported a false "denied" — so focus the frame
  // and wait for it to take, and refuse to report a clipboard verdict at all if we could
  // not get focus (`fail:UnfocusedHarness`), rather than mislabelling a harness artifact
  // as a permission decision.
  await probe("clipboardWrite", async () => {
    if (!navigator.clipboard?.writeText) throw new Error("no navigator.clipboard.writeText");
    window.focus();
    for (let i = 0; i < 40 && !document.hasFocus(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!document.hasFocus()) {
      const unfocused = new Error("could not focus the card; clipboard verdict is unobtainable");
      unfocused.name = "UnfocusedHarness";
      throw unfocused;
    }
    await navigator.clipboard.writeText("lvis-mcp-app-probe");
  });

  // 2. camera — getUserMedia({ video: true })
  await probe("camera", async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no navigator.mediaDevices");
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
  });

  // 3. microphone — getUserMedia({ audio: true })
  await probe("microphone", async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no navigator.mediaDevices");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  });

  // 4. geolocation — getCurrentPosition (callback API → promisified so `probe` can await)
  await probe("geolocation", async () => {
    if (!navigator.geolocation) throw new Error("no navigator.geolocation");
    await new Promise<void>((resolve, reject) => {
      // Bound it: a permission that is neither granted nor denied would otherwise hang
      // the probe forever and we would report nothing at all.
      const timer = setTimeout(() => reject(new Error("TimedOut|no callback in 8s")), 8_000);
      navigator.geolocation.getCurrentPosition(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          // GeolocationPositionError is not an Error — normalize so `probe` can read it.
          const named = new Error(err.message || "geolocation error");
          named.name = `GeolocationPositionError(code=${err.code})`;
          reject(named);
        },
        { timeout: 7_000 },
      );
    });
  });

  console.log(`E2E_PROBE ${CASE} DONE`);
}

void main();
