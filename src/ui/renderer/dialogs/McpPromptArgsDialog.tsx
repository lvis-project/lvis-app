/**
 * McpPromptArgsDialog — collect a server-declared prompt's arguments.
 *
 * MCP prompts are the USER-controlled primitive: the user picks one from the
 * slash picker, the host fetches it, and the server's text enters the turn as
 * untrusted, server-authored content. Anything a prompt needs from the user must
 * therefore be collected by the HOST chrome, in a surface the user recognizes as
 * the app asking — which is also why this is a real dialog and not `window.prompt`
 * (unavailable in the renderer) or a composer draft (a draft the user submits
 * would enter as `user-keyboard` and launder the provenance).
 *
 * Every label on this form — argument names, descriptions — is a string the MCP
 * SERVER wrote. It is rendered as text only (React escapes it), truncated so a
 * long value cannot push the actual controls off-screen, and framed by a notice
 * that says where it came from, so a prompt cannot dress itself up as host UI.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { useTranslation } from "../../../i18n/react.js";
import type { McpPromptEntry } from "../components/slash-picker-data.js";

/** Display caps for server-authored strings. Values are bounded again in main. */
const MAX_LABEL_CHARS = 96;
const MAX_DESCRIPTION_CHARS = 240;
/** Matches the per-value slice the `mcp:get-prompt` handler applies. */
const MAX_VALUE_CHARS = 4_096;
/**
 * A prompt asking for more than this many arguments is not a form a user can
 * meaningfully fill; the rest are dropped and the prompt is still runnable with
 * whatever it declared first (missing optional args are simply absent).
 */
const MAX_FIELDS = 16;

function clamp(value: string | undefined, max: number): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export interface McpPromptArgsDialogProps {
  /** The prompt awaiting arguments, or null when the dialog is closed. */
  prompt: McpPromptEntry | null;
  onCancel: () => void;
  onSubmit: (prompt: McpPromptEntry, args: Record<string, string>) => void;
}

export function McpPromptArgsDialog({ prompt, onCancel, onSubmit }: McpPromptArgsDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});

  const fields = useMemo(
    () => (prompt ? prompt.arguments.slice(0, MAX_FIELDS) : []),
    [prompt],
  );

  // A fresh prompt starts from an empty form — never inherit the previous
  // prompt's answers, which could send one server's input to another's.
  useEffect(() => {
    setValues({});
  }, [prompt]);

  const missingRequired = fields.some(
    (field) => field.required && (values[field.name] ?? "").trim().length === 0,
  );

  const submit = useCallback(() => {
    if (!prompt || missingRequired) return;
    const args: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.name] ?? "";
      // Optional arguments left blank are omitted rather than sent as "" — an
      // empty string is a value, and servers may treat the two differently.
      if (value.length === 0) continue;
      args[field.name] = value;
    }
    onSubmit(prompt, args);
  }, [fields, missingRequired, onSubmit, prompt, values]);

  if (!prompt) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent size="md" data-testid="mcp-prompt-args-dialog">
        <DialogHeader>
          <DialogTitle>{t("app.mcpPromptArgsTitle", { name: clamp(prompt.title ?? prompt.name, MAX_LABEL_CHARS) })}</DialogTitle>
          <DialogDescription>
            {t("app.mcpPromptArgsDescription", { serverId: clamp(prompt.serverId, MAX_LABEL_CHARS) })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-xs text-muted-foreground">{t("app.mcpPromptArgsUntrusted")}</p>

          {fields.map((field) => {
            const inputId = `mcp-prompt-arg-${field.name}`;
            return (
              <div className="flex flex-col gap-1.5" key={field.name}>
                <Label htmlFor={inputId}>
                  <span className="break-all">{clamp(field.name, MAX_LABEL_CHARS)}</span>
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {field.required ? t("app.mcpPromptArgsRequired") : t("app.mcpPromptArgsOptional")}
                  </span>
                </Label>
                {field.description ? (
                  <p className="text-xs text-muted-foreground">
                    {clamp(field.description, MAX_DESCRIPTION_CHARS)}
                  </p>
                ) : null}
                <Input
                  autoComplete="off"
                  data-testid={`mcp-prompt-arg-input-${field.name}`}
                  id={inputId}
                  maxLength={MAX_VALUE_CHARS}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                  }
                  value={values[field.name] ?? ""}
                />
              </div>
            );
          })}

          <DialogFooter>
            <Button onClick={onCancel} type="button" variant="ghost">
              {t("app.mcpPromptArgsCancel")}
            </Button>
            <Button
              data-testid="mcp-prompt-args-submit"
              disabled={missingRequired}
              type="submit"
            >
              {t("app.mcpPromptArgsSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
