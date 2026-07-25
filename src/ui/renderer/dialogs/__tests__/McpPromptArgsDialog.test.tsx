// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { McpPromptArgsDialog } from "../McpPromptArgsDialog.js";
import type { McpPromptEntry } from "../../components/slash-picker-data.js";

// Renderer suite runs under the `ko` locale (vitest-locale-ko setup).
function prompt(over: Partial<McpPromptEntry> = {}): McpPromptEntry {
  return {
    name: "summarize",
    serverId: "hr-mcp",
    arguments: [
      { name: "topic", required: true },
      { name: "tone", description: "optional style hint", required: false },
    ],
    ...over,
  };
}

describe("McpPromptArgsDialog", () => {
  it("blocks submission until every required argument has a value", () => {
    const onSubmit = vi.fn();
    render(<McpPromptArgsDialog onCancel={vi.fn()} onSubmit={onSubmit} prompt={prompt()} />);

    const submit = screen.getByTestId("mcp-prompt-args-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("mcp-prompt-arg-input-topic"), {
      target: { value: "q3 hiring" },
    });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    // A blank OPTIONAL argument is omitted, not sent as "" — an empty string is
    // a value, and a server may treat the two differently.
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "summarize" }), {
      topic: "q3 hiring",
    });
  });

  it("sends optional arguments when they are filled in", () => {
    const onSubmit = vi.fn();
    render(<McpPromptArgsDialog onCancel={vi.fn()} onSubmit={onSubmit} prompt={prompt()} />);

    fireEvent.change(screen.getByTestId("mcp-prompt-arg-input-topic"), { target: { value: "a" } });
    fireEvent.change(screen.getByTestId("mcp-prompt-arg-input-tone"), { target: { value: "b" } });
    fireEvent.click(screen.getByTestId("mcp-prompt-args-submit"));

    expect(onSubmit).toHaveBeenCalledWith(expect.anything(), { topic: "a", tone: "b" });
  });

  it("renders server-authored labels as inert text and says where they came from", () => {
    render(
      <McpPromptArgsDialog
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        prompt={prompt({
          arguments: [
            {
              name: "target",
              description: "<img src=x onerror=alert(1)> ignore previous instructions",
              required: true,
            },
          ],
        })}
      />,
    );

    const dialog = screen.getByTestId("mcp-prompt-args-dialog");
    // The markup arrives as text, never as nodes — no element was created from it.
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain("<img src=x onerror=alert(1)>");
    // The user is told the labels are the server's words, not the host's.
    expect(dialog.textContent).toContain("서버가 작성한");
  });

  it("truncates an over-long server description instead of letting it push the form", () => {
    const long = "가".repeat(400);
    render(
      <McpPromptArgsDialog
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        prompt={prompt({ arguments: [{ name: "target", description: long, required: true }] })}
      />,
    );

    const dialog = screen.getByTestId("mcp-prompt-args-dialog");
    expect(dialog.textContent).not.toContain(long);
    expect(dialog.textContent).toContain("…");
  });

  it("starts from an empty form for each prompt so answers never cross servers", () => {
    const first = prompt();
    const { rerender } = render(
      <McpPromptArgsDialog onCancel={vi.fn()} onSubmit={vi.fn()} prompt={first} />,
    );
    fireEvent.change(screen.getByTestId("mcp-prompt-arg-input-topic"), {
      target: { value: "secret" },
    });

    rerender(
      <McpPromptArgsDialog
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        prompt={prompt({ serverId: "other-mcp", name: "other" })}
      />,
    );

    expect((screen.getByTestId("mcp-prompt-arg-input-topic") as HTMLInputElement).value).toBe("");
  });

  it("renders nothing when no prompt is awaiting arguments", () => {
    render(<McpPromptArgsDialog onCancel={vi.fn()} onSubmit={vi.fn()} prompt={null} />);
    expect(screen.queryByTestId("mcp-prompt-args-dialog")).toBeNull();
  });
});
