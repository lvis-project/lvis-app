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
      onBack={onBack}
      backTestId="settings-inline-back"
      className="px-4 pt-4"
      contentClassName="flex min-h-0 flex-1 flex-col"
    >
      <SettingsContent api={api} onSaved={onSaved} initialTab={initialTab} />
    </PageShell>
  );
}
