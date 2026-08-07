import { describe, expect, it } from "vitest";

import {
  detectApprovalIntent,
  MAX_INTENT_TEXT_LENGTH,
  MAX_SCOPED_INTENT_TEXT_LENGTH,
  NARROWEST_SCOPE,
  type ApprovalIntent,
} from "../approval-intent.js";

function approve(text: string): Extract<ApprovalIntent, { kind: "approve" }> {
  const intent = detectApprovalIntent(text);
  if (intent.kind !== "approve") {
    throw new Error(`expected approve for ${JSON.stringify(text)}, got ${intent.kind}`);
  }
  return intent;
}

describe("approval-intent scope slot — explicit breadths", () => {
  it.each([
    ["이번 턴만 허용", "once"],
    ["이번만 허용", "once"],
    ["한 번만 허용", "once"],
    ["allow once", "once"],
    ["allow just this time", "once"],
    ["이번 세션 동안 허용", "session"],
    ["이 세션만 허용", "session"],
    ["allow for this session", "session"],
    ["항상 허용", "always"],
    ["영구히 허용", "always"],
    ["앞으로 허용", "always"],
    ["always allow", "always"],
    ["allow permanently", "always"],
    ["allow from now on", "always"],
  ] as const)("parses %s as scope %s", (text, expected) => {
    const intent = approve(text);
    expect(intent.scope.value).toBe(expected);
    expect(intent.scope.explicit).toBe(true);
  });
});

describe("approval-intent scope slot — ambiguity resolves narrow", () => {
  // The single most common approval phrasing in the issue's own corpus.
  // "계속" means "keep going", NOT "grant this forever". Reading it as
  // "always" would silently convert routine approvals into standing grants.
  it.each(["계속 진행해 주세요", "진행해 계속", "continue and proceed"])(
    "does not read a continuation phrase as a standing grant: %s",
    (text) => {
      const intent = approve(text);
      expect(intent.scope.explicit).toBe(false);
      expect(intent.scope.value).toBe(NARROWEST_SCOPE);
    },
  );

  it.each([
    "이번 턴만 허용하고 앞으로도 허용",
    "allow once and always",
    "이번 세션 동안 그리고 항상 허용",
    "allow this time, always",
  ])("refuses a sentence mixing two breadths: %s", (text) => {
    const intent = approve(text);
    expect(intent.scope.explicit).toBe(false);
    expect(intent.scope.value).toBe(NARROWEST_SCOPE);
  });

  it("defaults to the narrowest scope when no breadth is named", () => {
    const intent = approve("허용");
    expect(intent.scope.explicit).toBe(false);
    expect(intent.scope.value).toBe(NARROWEST_SCOPE);
  });

  it("never resolves an unstated scope to anything but the narrowest", () => {
    // Guards the narrowing rule itself rather than one phrasing: no input
    // that leaves `explicit` false may carry a widened value.
    const corpus = [
      "허용",
      "승인",
      "allow",
      "proceed",
      "계속 진행해 주세요",
      "allow once and always",
      "go ahead",
    ];
    for (const text of corpus) {
      const intent = detectApprovalIntent(text);
      if (intent.kind !== "approve") continue;
      if (!intent.scope.explicit) {
        expect(intent.scope.value).toBe(NARROWEST_SCOPE);
      }
    }
  });
});

describe("approval-intent target slot — accepted paths", () => {
  it("extracts a POSIX absolute path alongside a scope", () => {
    const intent = approve("이번 세션 동안 /etc 허용");
    expect(intent.scope.value).toBe("session");
    expect(intent.target).toEqual({ kind: "path", raw: "/etc" });
  });

  it("extracts a Windows absolute path", () => {
    const intent = approve("allow C:\\srv\\app for this session");
    expect(intent.target).toEqual({ kind: "path", raw: "C:\\srv\\app" });
  });

  it("keeps a dotted filename intact instead of reading it as two sentences", () => {
    // Without path masking, "hosts.conf" makes countSentences() return 2 and
    // the whole directive is discarded.
    const intent = approve("allow /etc/hosts.conf for this session");
    expect(intent.target).toEqual({ kind: "path", raw: "/etc/hosts.conf" });
    expect(intent.scope.value).toBe("session");
  });

  it("strips trailing sentence punctuation from the path", () => {
    expect(approve("allow /etc/hosts for this session.").target).toEqual({
      kind: "path",
      raw: "/etc/hosts",
    });
  });
});

describe("approval-intent target slot — adversarial inputs resolve to no target", () => {
  it.each([
    ["traversal", "allow /srv/app/../../etc for this session"],
    ["windows traversal", "allow C:\\srv\\..\\..\\Windows for this session"],
    ["percent-encoded traversal", "allow /srv/%2e%2e/root for this session"],
    ["posix root", "allow / for this session"],
    ["windows volume root", "allow C:\\ for this session"],
    ["two paths", "allow /etc and /var for this session"],
    ["glob", "allow /etc/* for this session"],
    ["url", "allow https://example.com/x for this session"],
    ["unc share", "allow \\\\server\\share for this session"],
    ["hangul particle attached", "이번 세션 동안 /etc만 허용"],
  ])("%s yields no target", (_label, text) => {
    const intent = detectApprovalIntent(text);
    if (intent.kind !== "approve") return; // refusing outright is also narrow
    expect(intent.target).toEqual({ kind: "none" });
  });

  it("a refused target never leaves a widened scope pointing at nothing concrete", () => {
    // The dangerous shape is "always + unusable target": if the target is
    // dropped the caller must still be able to fall back to the host's own
    // path, so the scope stays attached but the target must be `none`.
    const intent = approve("always allow /srv/app/../../etc");
    expect(intent.scope.value).toBe("always");
    expect(intent.target).toEqual({ kind: "none" });
  });
});

describe("approval-intent length cuts", () => {
  it("keeps the plain cut for sentences with no filled slot", () => {
    const text = "음 승인은 아직 잘 모르겠고 나중에 다시 볼게";
    expect(text.length).toBeGreaterThan(MAX_INTENT_TEXT_LENGTH);
    expect(detectApprovalIntent(text).kind).toBe("none");
  });

  it("accepts the issue's motivating sentence, which the plain cut dropped", () => {
    const text = "이번 턴만 해당 경로에 대한 접근 권한 허용한다";
    expect(text.length).toBeGreaterThan(MAX_INTENT_TEXT_LENGTH);
    const intent = approve(text);
    expect(intent.scope.value).toBe("once");
    expect(intent.scope.explicit).toBe(true);
    // "해당 경로" is a demonstrative — the concrete path comes from the host.
    expect(intent.target).toEqual({ kind: "none" });
  });

  it("still cuts a slot-filled sentence past the scoped bound", () => {
    const text = `이번 세션 동안 허용 ${"가".repeat(MAX_SCOPED_INTENT_TEXT_LENGTH)}`;
    expect(detectApprovalIntent(text).kind).toBe("none");
  });

  it("honours caller-supplied bounds", () => {
    const text = "이번 세션 동안 허용";
    expect(detectApprovalIntent(text, { maxScopedLength: 4 }).kind).toBe("none");
  });
});

describe("approval-intent scope slot — existing refusals still win", () => {
  it.each([
    "항상 허용하지마",
    "이번 세션 동안 허용하지 마세요",
    "never allow always",
    "always allow?",
  ])("a negated or interrogative scoped sentence yields none: %s", (text) => {
    expect(detectApprovalIntent(text).kind).toBe("none");
  });

  it("a scoped reject stays a plain reject with no scope field", () => {
    const intent = detectApprovalIntent("이번 세션 동안 거부한다");
    expect(intent.kind).toBe("reject");
    expect(intent).not.toHaveProperty("scope");
  });
});
