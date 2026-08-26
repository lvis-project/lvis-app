import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
const schema = JSON.parse(readFileSync("schemas/plugin-manifest.schema.json", "utf8"));
const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const v = ajv.compile(schema);
const dir = "/private/tmp/ap-conform/probe";
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
  const doc = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const ok = v(doc);
  console.log(ok ? "PASS" : "FAIL", f, ok ? "" : JSON.stringify(v.errors, null, 1).slice(0, 900));
}
