/**
 * SettingsTextField — the shared "type a value, press Save" settings row.
 *
 * The behaviours worth pinning are the ones that used to be re-derived per
 * tab: Save applies what is in the box and is reachable whenever the box
 * differs from it, the field's own normalize rule decides what "apply" means,
 * a settings broadcast that did not move the value must not wipe an
 * in-progress edit, and one that did move it must win.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { SettingsTextField } from "../SettingsTextField.js";

function renderField(props: Partial<React.ComponentProps<typeof SettingsTextField>> = {}) {
  const onCommit = props.onCommit ?? vi.fn();
  const utils = render(
    <SettingsTextField
      id="field"
      label="Field"
      value="stored"
      onCommit={onCommit}
      {...props}
    />,
  );
  return { ...utils, onCommit };
}

describe("SettingsTextField", () => {
  it("starts on the committed value with Save disabled", async () => {
    const { findByTestId } = renderField();
    expect(((await findByTestId("field")) as HTMLInputElement).value).toBe("stored");
    expect(((await findByTestId("field-save")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("commits the trimmed draft", async () => {
    const { findByTestId, onCommit } = renderField();
    fireEvent.change(await findByTestId("field"), { target: { value: "  next  " } });
    fireEvent.click(await findByTestId("field-save"));
    expect(onCommit).toHaveBeenCalledWith("next");
  });

  it("commits on Enter as well as on Save", async () => {
    const { findByTestId, onCommit } = renderField();
    const input = await findByTestId("field");
    fireEvent.change(input, { target: { value: "typed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("typed");
  });

  it("does not commit a draft that normalizes back to the stored value", async () => {
    const { findByTestId, onCommit } = renderField();
    const input = (await findByTestId("field")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: " stored " } });
    fireEvent.click(await findByTestId("field-save"));
    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe("stored"));
  });

  it("applies the field's own normalize rule before comparing and committing", async () => {
    const { findByTestId, onCommit } = renderField({
      value: "fallback",
      normalize: (raw) => raw.trim() || "fallback",
    });
    const input = (await findByTestId("field")) as HTMLInputElement;
    // Clearing means "use the default". Save stays reachable so the field can
    // snap back to showing what the app is running on, and commits nothing
    // because the default is already the stored value.
    fireEvent.change(input, { target: { value: "" } });
    expect(((await findByTestId("field-save")) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(await findByTestId("field-save"));
    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe("fallback"));
  });

  it("keeps an in-progress edit when a re-render does not move the stored value", async () => {
    const onCommit = vi.fn();
    const { findByTestId, rerender } = render(
      <SettingsTextField id="field" label="Field" value="stored" onCommit={onCommit} />,
    );
    const input = (await findByTestId("field")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "half-typed" } });
    rerender(
      <SettingsTextField id="field" label="Field" value="stored" onCommit={onCommit} disabled={false} />,
    );
    expect(input.value).toBe("half-typed");
  });

  it("follows the stored value when it moves underneath the draft", async () => {
    const onCommit = vi.fn();
    const { findByTestId, rerender } = render(
      <SettingsTextField id="field" label="Field" value="stored" onCommit={onCommit} />,
    );
    const input = (await findByTestId("field")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "half-typed" } });
    rerender(
      <SettingsTextField id="field" label="Field" value="elsewhere" onCommit={onCommit} />,
    );
    await waitFor(() => expect(input.value).toBe("elsewhere"));
  });

  it("disables the input and Save together", async () => {
    const { findByTestId } = renderField({ disabled: true });
    expect(((await findByTestId("field")) as HTMLInputElement).disabled).toBe(true);
    expect(((await findByTestId("field-save")) as HTMLButtonElement).disabled).toBe(true);
  });
});
