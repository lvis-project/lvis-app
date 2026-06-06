// #811 milestone-2 lifecycle fixture: always DENIES.
// Used to prove the NON-BLOCKING contract: a lifecycle hook's deny is recorded
// but the caller IGNORES the decision (control flow is unaffected). The reason
// echoes the event so the deny is identifiable in the audit results.
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
  process.stdout.write(
    JSON.stringify({ action: "deny", reason: "lifecycle deny for " + p.event }),
  );
});
