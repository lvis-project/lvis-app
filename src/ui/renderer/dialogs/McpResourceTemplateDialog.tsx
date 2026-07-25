/**
 * McpResourceTemplateDialog — fill in a server-declared URI template.
 *
 * Sibling of {@link McpPromptArgsDialog} and shaped like it deliberately: a template is
 * the OTHER user-controlled primitive that needs input before a round trip, and the
 * three rules that dialog documents hold here for the same reasons.
 *
 *   - names are VALIDATED, not just displayed. `resources/templates/list` output is a
 *     cast, not a check. Here the host has already derived `variables` at discovery, so
 *     this form re-checks the SHAPE rather than re-deriving the list — the derivation
 *     stays in one place (`mcp-resource-template-bounds.ts`) and a form that disagreed
 *     with the expansion would offer fields main then drops.
 *   - collected values live in a `Map`, never a plain object, so a variable named
 *     `toString` cannot read off `Object.prototype` (`(…).trim is not a function` during
 *     render — and this dialog mounts outside the error boundary). `Object.fromEntries`
 *     converts at the boundary because it DEFINES own properties; plain assignment would
 *     hand `__proto__` to the prototype setter and swallow that one field.
 *   - the bounds MATCH main's, from the one shared module, because a field the user can
 *     fill that main then drops is worse than no field at all.
 *
 * What is NOT like the prompt dialog: every variable is REQUIRED. RFC 6570 Level 1 would
 * expand a missing one to nothing, which silently points at the directory above — a
 * different resource than the user asked for, and one they cannot see they asked for. So
 * main refuses that expansion, and this form will not submit it either.
 *
 * The user does not see or type a URI. They fill fields; main expands. That is what stops
 * anything typed here from moving the read off the path the server published.
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
  isUsableTemplateVariableName,
  MCP_RESOURCE_TEMPLATE_MAX_VARIABLES,
  MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS,
} from "../../../shared/mcp-resource-template-bounds.js";
import { displaySafeLabel } from "../../../shared/display-safe-text.js";
import { useTranslation } from "../../../i18n/react.js";
import type { PendingResourceTemplate } from "../hooks/use-resource-mention.js";

/** Display cap for server-authored strings. Values are bounded again in main. */
const MAX_LABEL_CHARS = 96;

/**
 * The variables this form will offer.
 *
 * De-duplicated because one name is one field substituted at every occurrence, and capped
 * at the number main will carry. A name that fails the shape check is dropped — the host
 * derived this list from a template it had already validated, so a failure here means the
 * two disagree, and the honest response is to offer no field rather than one whose value
 * the expansion would ignore.
 */
function usableVariables(variables: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const name of variables) {
    if (!isUsableTemplateVariableName(name) || seen.has(name)) continue;
    if (kept.length >= MCP_RESOURCE_TEMPLATE_MAX_VARIABLES) break;
    seen.add(name);
    kept.push(name);
  }
  return kept;
}

export interface McpResourceTemplateDialogProps {
  /** The template awaiting values, or null when the dialog is closed. */
  pending: PendingResourceTemplate | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

export function McpResourceTemplateDialog({
  pending,
  onCancel,
  onSubmit,
}: McpResourceTemplateDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<ReadonlyMap<string, string>>(() => new Map());

  const fields = useMemo(
    () => (pending ? usableVariables(pending.variables) : []),
    [pending],
  );

  // A fresh template starts from an empty form — never inherit the previous one's
  // answers, which could send one server's input to another's.
  useEffect(() => {
    setValues(new Map());
  }, [pending]);

  // Every variable is required (see the header): an unfilled one is a refusal in main.
  // A template with no usable field is not runnable at all rather than submitted empty.
  const runnable =
    fields.length > 0
    && fields.every((name) => (values.get(name) ?? "").trim().length > 0);

  const submit = useCallback(() => {
    if (!pending || !runnable) return;
    onSubmit(Object.fromEntries(fields.map((name) => [name, values.get(name) ?? ""])));
  }, [fields, onSubmit, pending, runnable, values]);

  if (!pending) return null;

  const unrunnable = fields.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent size="md" data-testid="mcp-resource-template-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("app.mcpResourceTemplateTitle", {
              name: displaySafeLabel(pending.label, MAX_LABEL_CHARS),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("app.mcpResourceTemplateDescription", {
              serverId: displaySafeLabel(pending.serverId, MAX_LABEL_CHARS),
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-xs text-muted-foreground">{t("app.mcpResourceTemplateUntrusted")}</p>

          {unrunnable ? (
            <p
              className="text-xs text-destructive"
              data-testid="mcp-resource-template-unrunnable"
              role="alert"
            >
              {t("app.mcpResourceTemplateUnrunnable")}
            </p>
          ) : null}

          {fields.map((name) => {
            const inputId = `mcp-resource-template-var-${name}`;
            return (
              <div className="flex flex-col gap-1.5" key={name}>
                <Label htmlFor={inputId}>
                  <span className="break-all">{displaySafeLabel(name, MAX_LABEL_CHARS)}</span>
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {t("app.mcpResourceTemplateRequired")}
                  </span>
                </Label>
                <Input
                  autoComplete="off"
                  data-testid={`mcp-resource-template-input-${name}`}
                  id={inputId}
                  maxLength={MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValues((prev) => new Map(prev).set(name, next));
                  }}
                  value={values.get(name) ?? ""}
                />
              </div>
            );
          })}

          <DialogFooter>
            <Button
              data-testid="mcp-resource-template-cancel"
              onClick={onCancel}
              type="button"
              variant="ghost"
            >
              {t("app.mcpResourceTemplateCancel")}
            </Button>
            <Button
              data-testid="mcp-resource-template-submit"
              disabled={!runnable}
              type="submit"
            >
              {t("app.mcpResourceTemplateSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
