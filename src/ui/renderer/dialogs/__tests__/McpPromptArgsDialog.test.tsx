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

  // `prompts/list` output is a cast, not a check. A name that collides with an
  // Object.prototype member used to be read off the prototype — `(…).trim is not a
  // function` DURING RENDER, and this dialog mounts outside the error boundary, so
  // the whole renderer unmounted.
  it("handles an argument named like an Object.prototype member", () => {
    const onSubmit = vi.fn();
    render(
      <McpPromptArgsDialog
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        prompt={prompt({ arguments: [{ name: "toString", required: true }] })}
      />,
    );

    const input = screen.getByTestId("mcp-prompt-arg-input-toString") as HTMLInputElement;
    expect(input.value).toBe("");
    expect((screen.getByTestId("mcp-prompt-args-submit") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "v" } });
    fireEvent.click(screen.getByTestId("mcp-prompt-args-submit"));
    expect(onSubmit).toHaveBeenCalledWith(expect.anything(), { toString: "v" });
  });

  it("drops arguments whose declared name is not a usable string", () => {
    render(
      <McpPromptArgsDialog
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        prompt={prompt({
          arguments: [
            // Shapes a hostile or buggy server can actually put on the wire.
            { name: 42 as unknown as string, required: false },
            { name: "", required: false },
            { name: "ok", required: false },
          ],
        })}
      />,
    );

    const dialog = screen.getByTestId("mcp-prompt-args-dialog");
    expect(dialog.querySelectorAll("input")).toHaveLength(1);
    expect(screen.getByTestId("mcp-prompt-arg-input-ok")).toBeTruthy();
  });

  it("collapses duplicate argument names into one field", () => {
    render(
      <McpPromptArgsDialog
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        prompt={prompt({
          arguments: [
            { name: "topic", required: true },
            { name: "topic", description: "the same name twice", required: false },
          ],
        })}
      />,
    );

    expect(screen.getByTestId("mcp-prompt-args-dialog").querySelectorAll("input")).toHaveLength(1);
  });

  // Main bounds argument KEYS at 64 chars. A longer required name used to render a
  // field the user could fill, which main then dropped — the request went out
  // without it and failed server-side with a generic toast.
  it("refuses to run a prompt whose required argument the form cannot offer", () => {
    render(
      <McpPromptArgsDialog
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        prompt={prompt({ arguments: [{ name: "x".repeat(65), required: true }] })}
      />,
    );

    const dialog = screen.getByTestId("mcp-prompt-args-dialog");
    expect(dialog.querySelectorAll("input")).toHaveLength(0);
    expect(screen.getByTestId("mcp-prompt-args-unrunnable")).toBeTruthy();
    expect((screen.getByTestId("mcp-prompt-args-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders nothing when no prompt is awaiting arguments", () => {
    render(<McpPromptArgsDialog onCancel={vi.fn()} onSubmit={vi.fn()} prompt={null} />);
    expect(screen.queryByTestId("mcp-prompt-args-dialog")).toBeNull();
  });
});
