import test from "node:test";
import assert from "node:assert/strict";

import { parseEnvDemoText } from "../env-demo-parser.mjs";

test("parseEnvDemoText accepts the activation/local .env.demo shape", () => {
  assert.deepEqual(
    parseEnvDemoText([
      "# comment",
      "export FOO=bar",
      'QUOTED="hello"',
      "SINGLE='world'",
      "LVIS_DEMO_HOST_MAP=",
      "no-equals-here",
      "BAZ=qux",
      "",
    ].join("\n")),
    {
      FOO: "bar",
      QUOTED: "hello",
      SINGLE: "world",
      LVIS_DEMO_HOST_MAP: "",
      BAZ: "qux",
    },
  );
});
