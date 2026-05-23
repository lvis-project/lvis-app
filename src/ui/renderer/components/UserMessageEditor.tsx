import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Textarea } from "../../../components/ui/textarea.js";

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
  const [draft, setDraft] = useState(initialText);
  return (
    <div className="ml-auto w-full max-w-[75%] rounded-md border bg-message-user/10 p-2 text-sm">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-[60px] text-sm"
        autoFocus
      />
      <div className="mt-1 flex justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onCancel} disabled={busy}>취소</Button>
        <Button size="sm" className="h-6 text-xs" onClick={() => onSave(draft)} disabled={busy || !draft.trim()}>저장 후 재전송</Button>
      </div>
    </div>
  );
}
