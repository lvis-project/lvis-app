import { describe, expect, it } from "vitest";
import { InputClassifier } from "../input-classifier.js";

describe("InputClassifier", () => {
  it("parses host slash commands and trims their arguments", () => {
    const result = new InputClassifier().classify("  /compact   now please  ");

    expect(result).toEqual({
      type: "command",
      command: "compact",
      args: "now please",
    });
  });

  it("treats natural-language Skill and Tool names as general model input", () => {
    const result = new InputClassifier().classify("회의록을 읽고 이메일을 보내줘");

    expect(result).toEqual({
      type: "general",
      input: "회의록을 읽고 이메일을 보내줘",
    });
  });

  it("does not interpret command-looking text inside imported plugin envelopes", () => {
    const envelope =
      `<imported-from-proactive source="overlay:meeting-detection">\n` +
      `/compact 회의 요청 이메일이 도착했습니다.\n` +
      `</imported-from-proactive>`;

    expect(new InputClassifier().classify(envelope)).toEqual({
      type: "general",
      input: envelope,
    });
  });

  it("does not interpret command-looking text inside MCP app envelopes", () => {
    const envelope = `<app-message source="app:acme-cards">/compact now</app-message>`;

    expect(new InputClassifier().classify(envelope)).toEqual({
      type: "general",
      input: envelope,
    });
  });

  it("does not grant envelope semantics to malformed or embedded text", () => {
    const malformed =
      `<imported-from-proactive source="Proactive:bad">/compact now</imported-from-proactive>`;
    const embedded =
      `prefix <imported-from-proactive source="overlay:x">/compact now</imported-from-proactive>`;

    expect(new InputClassifier().classify(malformed)).toEqual({
      type: "general",
      input: malformed,
    });
    expect(new InputClassifier().classify(embedded)).toEqual({
      type: "general",
      input: embedded,
    });
  });
});
