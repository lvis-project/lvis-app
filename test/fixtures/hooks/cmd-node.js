// #811 command-hooks fixture: a Node command hook.
// Reads the wire-shape JSON on stdin and emits {action,reason}. Echoes the
// received trustOrigin in the reason to prove the stdin payload round-trips.
let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ action: "deny", reason: "bad stdin" }));
    return;
  }
  process.stdout.write(
    JSON.stringify({ action: "allow", reason: "node ok origin=" + payload.trustOrigin }),
  );
});
