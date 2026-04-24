import { Button } from "../../components/ui/button.js";
import { getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginUiExtension } from "./types.js";

export interface SidebarProps {
  activeView: string;
  pluginViews: PluginUiExtension[];
  setActiveView: (key: string) => void;
  starredCount: number;
}

export function Sidebar(props: SidebarProps) {
  const { activeView, pluginViews, setActiveView, starredCount } = props;
  const navItems = [
    { key: "home", label: "홈" },
    { key: "tasks", label: "태스크" },
    { key: "routines", label: "루틴" },
    { key: "starred", label: "즐겨찾기", badge: starredCount > 0 ? `(${starredCount})` : null },
    { key: "memory", label: "메모리" },
    ...pluginViews.map((view) => ({
      key: toViewKey(view),
      label: getPluginViewLabel(view),
    })),
  ];

  return (
    <aside className="flex min-h-0 w-32 shrink-0 flex-col border-r bg-background px-3 py-4">
      <div className="mb-4 px-2 text-xs font-semibold tracking-wide text-muted-foreground">
        메뉴
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto pr-1">
        {navItems.map((item) => (
          <Button
            key={item.key}
            variant={activeView === item.key ? "secondary" : "ghost"}
            className="w-full min-w-0 justify-start gap-2 px-3"
            onClick={() => setActiveView(item.key)}
          >
            <span className="truncate">{item.label}</span>
            {item.badge ? <span className="shrink-0 text-[10px] text-muted-foreground">{item.badge}</span> : null}
          </Button>
        ))}
      </div>
    </aside>
  );
}
