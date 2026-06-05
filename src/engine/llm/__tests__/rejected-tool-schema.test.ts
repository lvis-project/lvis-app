import { describe, it, expect } from "vitest";
import { rejectedToolNameFromError } from "../rejected-tool-schema.js";
import type { ProviderErrorDiagnostics } from "../provider-error-diagnostics.js";

function diag(over: Partial<ProviderErrorDiagnostics>): ProviderErrorDiagnostics {
  return { origin: "provider", messagePreview: "", ...over };
}

const KNOWN = ["good_tool", "bad_tool", "meeting_register_scheduled_meeting"];

describe("rejectedToolNameFromError — provider-as-oracle (#1182)", () => {
  it("returns the named tool when providerCode is invalid_function_parameters and the name is known", () => {
    const d = diag({
      statusCode: 400,
      providerCode: "invalid_function_parameters",
      messagePreview:
        "Invalid schema for function 'bad_tool': In context=('properties','tags'), array schema is missing items.",
    });
    expect(rejectedToolNameFromError(d, KNOWN)).toBe("bad_tool");
  });

  it("detects via message alone when no providerCode is present (non-JSON error body)", () => {
    const d = diag({
      messagePreview: "Invalid schema for function 'meeting_register_scheduled_meeting': type union missing items",
    });
    expect(rejectedToolNameFromError(d, KNOWN)).toBe("meeting_register_scheduled_meeting");
  });

  it("accepts single, double, and backtick quote styles around the name", () => {
    for (const q of ["'", '"', "`"]) {
      const d = diag({
        providerCode: "invalid_function_parameters",
        messagePreview: `Invalid schema for tool ${q}good_tool${q}: bad`,
      });
      expect(rejectedToolNameFromError(d, KNOWN)).toBe("good_tool");
    }
  });

  it("returns undefined when the named function is not in the current tool set (dropping wouldn't help)", () => {
    const d = diag({
      providerCode: "invalid_function_parameters",
      messagePreview: "Invalid schema for function 'some_builtin_we_dont_send': bad",
    });
    expect(rejectedToolNameFromError(d, KNOWN)).toBeUndefined();
  });

  it("returns undefined for a non-schema error (rate limit) even if it mentions a tool", () => {
    const d = diag({
      providerCode: "rate_limit_exceeded",
      statusCode: 429,
      messagePreview: "Rate limit reached for function calls; please retry the bad_tool later",
    });
    expect(rejectedToolNameFromError(d, KNOWN)).toBeUndefined();
  });

  it("returns undefined when it IS a schema rejection but no name can be parsed (so the caller does not retry blindly)", () => {
    const d = diag({
      providerCode: "invalid_function_parameters",
      statusCode: 400,
      messagePreview: "invalid_function_parameters: tools[3].function.parameters failed validation",
    });
    expect(rejectedToolNameFromError(d, KNOWN)).toBeUndefined();
  });

  it("is total — undefined providerError and empty known set never throw", () => {
    expect(rejectedToolNameFromError(undefined, KNOWN)).toBeUndefined();
    expect(
      rejectedToolNameFromError(
        diag({ providerCode: "invalid_function_parameters", messagePreview: "Invalid schema for function 'bad_tool'" }),
        [],
      ),
    ).toBeUndefined();
  });
});
