export function parseEnvDemoText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.replace(/^export\s+/, "");
    const eq = stripped.indexOf("=");
    if (eq < 1) continue;
    const key = stripped.slice(0, eq).trim();
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key.length > 0) {
      out[key] = val;
    }
  }
  return out;
}
