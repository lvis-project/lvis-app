// #811 milestone-2 lifecycle fixture: echoes the received lifecycle payload.
// Reads the wire-shape JSON on stdin and reflects the event + a few payload
// fields into the `reason` so a test can assert the right payload reached the
// hook. Always `allow` — the observe-only semantics mean the decision is
// ignored by the caller anyway; the reason is the verification surface.
let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ action: "deny", reason: "bad stdin" }));
    return;
  }
  // Reflect the discriminating fields. JSON.stringify(undefined) → omitted, so
  // only the fields present for THIS event show up.
  const parts = [
    "event=" + p.event,
    "session=" + p.sessionId,
    p.toolName !== undefined ? "tool=" + p.toolName : null,
    p.errorMessage !== undefined ? "err=" + p.errorMessage : null,
    p.durationMs !== undefined ? "dur=" + p.durationMs : null,
    p.denyReason !== undefined ? "deny=" + JSON.stringify(p.denyReason) : null,
    p.sessionMeta !== undefined ? "meta=" + JSON.stringify(p.sessionMeta) : null,
    p.stopReason !== undefined ? "stop=" + p.stopReason : null,
    p.toolCount !== undefined ? "count=" + p.toolCount : null,
    p.reason !== undefined ? "reason=" + p.reason : null,
    p.tokenEstimate !== undefined ? "est=" + p.tokenEstimate : null,
    p.messagesBefore !== undefined ? "mb=" + p.messagesBefore : null,
    p.messagesAfter !== undefined ? "ma=" + p.messagesAfter : null,
    p.tokensBefore !== undefined ? "tb=" + p.tokensBefore : null,
    p.tokensAfter !== undefined ? "ta=" + p.tokensAfter : null,
    // #811 m2 — UserPromptSubmit (blocking) fields.
    p.inputText !== undefined ? "text=" + p.inputText : null,
    p.inputOrigin !== undefined ? "origin=" + p.inputOrigin : null,
    p.route !== undefined ? "route=" + p.route : null,
    p.classification !== undefined ? "class=" + p.classification : null,
  ].filter((s) => s !== null);
  process.stdout.write(JSON.stringify({ action: "allow", reason: parts.join(" ") }));
});
