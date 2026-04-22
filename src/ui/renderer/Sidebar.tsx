import { Button } from "../../components/ui/button.js";
import { getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginUiExtension } from "./types.js";

export interface SidebarProps {
  pluginViews: PluginUiExtension[];
  setActiveView: (key: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const { pluginViews, setActiveView } = props;
  if (pluginViews.length === 0) return null;
  return (
    <aside className="border-r bg-background p-4 space-y-1">
      {pluginViews.map((v) => (
        <Button key={toViewKey(v)} variant="ghost" className="w-full justify-start" onClick={() => setActiveView(toViewKey(v))}>
          {getPluginViewLabel(v)}
        </Button>
      ))}
    </aside>
  );
}
