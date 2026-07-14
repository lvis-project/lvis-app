import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Textarea } from "../../../components/ui/textarea.js";
import { useTranslation } from "../../../i18n/react.js";

/**
 * Inline editor for resending a user message. Renders as a
 * compact Textarea over the original bubble with Save/Cancel controls.
 */
export function UserMessageEditor({
  initialText,
  onCancel,
  onSave,
  busy,
}: {
  initialText: string;
  onCancel: () => void;
  onSave: (next: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialText);
  return (
    <div className="ml-auto w-full max-w-[75%] rounded-lg border border-message-user-border bg-message-user p-2 text-body-sm text-message-user-foreground">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-[60px] border-message-user-border bg-message-user text-body-sm text-message-user-foreground placeholder:text-message-user-muted focus-visible:ring-message-user-action focus-visible:ring-offset-message-user"
        autoFocus
      />
      <div className="mt-1 flex justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-6 text-caption text-message-user-action hover:bg-message-user-action/(--opacity-subtle) hover:text-message-user-action focus-visible:ring-message-user-action focus-visible:ring-offset-message-user" onClick={onCancel} disabled={busy}>{t("userMessageEditor.cancelButton")}</Button>
        <Button size="sm" className="h-6 text-caption focus-visible:ring-message-user-action focus-visible:ring-offset-message-user" onClick={() => onSave(draft)} disabled={busy || !draft.trim()}>{t("userMessageEditor.saveAndResendButton")}</Button>
      </div>
    </div>
  );
}
