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
 * SERVER wrote. Three rules follow, and all three are load-bearing:
 *   - names are VALIDATED, not just displayed: `prompts/list` output is a cast,
 *     not a check, so a non-string name would throw when React renders it;
 *   - collected values live in a `Map`, never a plain object, so a name like
 *     `toString` cannot read off `Object.prototype` (`(…).trim is not a function`
 *     during render — and this dialog mounts outside the error boundary);
 *   - the bounds here MATCH main's. A field the user can fill that main then
 *     drops is worse than no field at all.
 * Text is rendered as text (React escapes it) and truncated, under a notice
 * saying whose words these are, so a prompt cannot dress itself up as host UI.
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
import {
  isUsablePromptName,
  MCP_PROMPT_ARG_NAME_MAX_CHARS,
  MCP_PROMPT_ARG_VALUE_MAX_CHARS,
} from "../../../mcp/mcp-prompt-render.js";
import { useTranslation } from "../../../i18n/react.js";
import type { McpPromptEntry } from "../components/slash-picker-data.js";

/** Display caps for server-authored strings. Values are bounded again in main. */
const MAX_LABEL_CHARS = 96;
const MAX_DESCRIPTION_CHARS = 240;
/**
 * A prompt asking for more than this many arguments is not a form a person can
 * meaningfully fill. Excess fields are dropped — and if any DROPPED field was
 * required, the prompt is not runnable from here at all, which the dialog says
 * out loud instead of letting the user fill a form that must fail server-side.
 */
const MAX_FIELDS = 16;

interface PromptField {
  name: string;
  description?: string;
  required: boolean;
}

function clamp(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Reduce the server's declared arguments to fields this form can honestly offer:
 * usable names only, de-duplicated (two same-named args would share one input and
 * one value), and capped. Returns what was dropped so the caller can refuse to run
 * a prompt whose REQUIRED argument did not survive.
 */
function usableFields(prompt: McpPromptEntry): {
  fields: PromptField[];
  droppedRequired: boolean;
} {
  const seen = new Set<string>();
  const kept: PromptField[] = [];
  let droppedRequired = false;
  const declared = Array.isArray(prompt.arguments) ? prompt.arguments : [];
  for (const argument of declared) {
    const required = argument?.required === true;
    const name = argument?.name;
    if (!isUsablePromptName(name, MCP_PROMPT_ARG_NAME_MAX_CHARS) || seen.has(name)) {
      if (required) droppedRequired = true;
      continue;
    }
    if (kept.length >= MAX_FIELDS) {
      if (required) droppedRequired = true;
      continue;
    }
    seen.add(name);
    kept.push({
      name,
      ...(typeof argument.description === "string" ? { description: argument.description } : {}),
      required,
    });
  }
  return { fields: kept, droppedRequired };
}

export interface McpPromptArgsDialogProps {
  /** The prompt awaiting arguments, or null when the dialog is closed. */
  prompt: McpPromptEntry | null;
  onCancel: () => void;
  onSubmit: (prompt: McpPromptEntry, args: Record<string, string>) => void;
}

export function McpPromptArgsDialog({ prompt, onCancel, onSubmit }: McpPromptArgsDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<ReadonlyMap<string, string>>(() => new Map());

  const { fields, droppedRequired } = useMemo(
    () => (prompt ? usableFields(prompt) : { fields: [], droppedRequired: false }),
    [prompt],
  );

  // A fresh prompt starts from an empty form — never inherit the previous
  // prompt's answers, which could send one server's input to another's.
  useEffect(() => {
    setValues(new Map());
  }, [prompt]);

  const missingRequired = fields.some(
    (field) => field.required && (values.get(field.name) ?? "").trim().length === 0,
  );
  const runnable = !missingRequired && !droppedRequired;

  const submit = useCallback(() => {
    if (!prompt || !runnable) return;
    const args: Record<string, string> = {};
    for (const field of fields) {
      const value = values.get(field.name) ?? "";
      // Optional arguments left blank are omitted rather than sent as "" — an
      // empty string is a value, and servers may treat the two differently.
      if (value.length === 0) continue;
      args[field.name] = value;
    }
    onSubmit(prompt, args);
  }, [fields, onSubmit, prompt, runnable, values]);

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

          {droppedRequired ? (
            <p className="text-xs text-destructive" data-testid="mcp-prompt-args-unrunnable" role="alert">
              {t("app.mcpPromptArgsUnrunnable")}
            </p>
          ) : null}

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
                  disabled={droppedRequired}
                  id={inputId}
                  maxLength={MCP_PROMPT_ARG_VALUE_MAX_CHARS}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValues((prev) => new Map(prev).set(field.name, next));
                  }}
                  value={values.get(field.name) ?? ""}
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
              disabled={!runnable}
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
