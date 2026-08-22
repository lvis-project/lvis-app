/**
 * "Type a value, press Save" settings row — one implementation.
 *
 * Every free-text setting has the same four moving parts: a draft the user is
 * editing, a committed value the app is actually running on, a Save button
 * that must stay disabled while the two agree, and an Enter key that means
 * Save. The corporate-CA field hand-rolled all four, and each newly surfaced
 * text setting was another copy — which is how the trim rule, the disabled
 * rule, and the test ids drift apart one field at a time.
 *
 * `normalize` is the only part that genuinely differs between fields: some
 * settings fall back to a default when cleared, others are legitimately empty.
 * It runs before the comparison AND before the commit, so the value the Save
 * button is judging is the value the store will receive.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { useTranslation } from "../../../i18n/react.js";

export interface SettingsTextFieldProps {
  /** DOM id, shared with the label's `htmlFor`. Also the input's test id. */
  readonly id: string;
  readonly label: string;
  /** Sentence under the field. Omitted renders no paragraph. */
  readonly help?: string;
  /** The committed value — what the app is running on right now. */
  readonly value: string;
  /** Called only when the normalized draft differs from {@link value}. */
  readonly onCommit: (next: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /** Defaults to trimming. Return the value the store should hold. */
  readonly normalize?: (raw: string) => string;
  /** Spacing for the surrounding layout — the field's own styling is fixed. */
  readonly className?: string;
  /** Rendered under the help line — env-forced notices, bounds, warnings. */
  readonly children?: ReactNode;
}

const trimOnly = (raw: string): string => raw.trim();

export function SettingsTextField({
  id,
  label,
  help,
  value,
  onCommit,
  disabled,
  placeholder,
  normalize = trimOnly,
  className,
  children,
}: SettingsTextFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);

  // The committed value can move without the user touching the field — a
  // settings broadcast, another window, the first load resolving. The draft
  // follows it; anything the user typed against the old value was aimed at a
  // state the app has left.
  useEffect(() => { setDraft(value); }, [value]);

  // Save means "apply what is in the box", so it is disabled only when the box
  // already shows the stored value EXACTLY. Comparing the normalized draft
  // instead would disable Save on a field the user has cleared — leaving it
  // visibly empty, unable to commit, and with no way back to showing the value
  // the app is actually running on.
  const commit = () => {
    const normalized = normalize(draft);
    setDraft(normalized);
    if (normalized !== value) onCommit(normalized);
  };

  return (
    <div className={`space-y-2${className ? ` ${className}` : ""}`}>
      <Label className="text-sm font-medium" htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          disabled={disabled}
          className="flex-1"
          data-testid={id}
        />
        <Button
          type="button"
          size="sm"
          onClick={commit}
          disabled={disabled || draft === value}
          data-testid={`${id}-save`}
        >
          {t("common.save")}
        </Button>
      </div>
      {help ? (
        <p className="text-xs text-muted-foreground" data-testid={`${id}-help`}>{help}</p>
      ) : null}
      {children}
    </div>
  );
}
