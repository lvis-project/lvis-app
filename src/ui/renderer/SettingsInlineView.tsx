import { PageShell } from "./components/PageShell.js";
import { SettingsContent } from "./SettingsContent.js";
import type { LvisApi } from "./types.js";

export function SettingsInlineView({
  api,
  initialTab,
  onSaved,
  onBack,
}: {
  api: LvisApi;
  initialTab: string;
  onSaved: () => void;
  onBack: () => void;
}) {
  return (
    <PageShell
      padded={false}
      maxWidth="none"
      className="px-3 pt-4 sm:px-4"
      contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <SettingsContent api={api} onSaved={onSaved} initialTab={initialTab} onClose={onBack} />
    </PageShell>
  );
}
