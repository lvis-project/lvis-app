import { MoreHorizontal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { toViewKey } from "./api-client.js";
import type { MarketplaceItem, PluginUiExtension } from "./types.js";

export interface SidebarProps {
  marketStatus: string;
  marketplace: MarketplaceItem[];
  pluginViews: PluginUiExtension[];
  working: boolean;
  setInstallTarget: (item: MarketplaceItem) => void;
  setUninstallTarget: (item: MarketplaceItem) => void;
  setActiveView: (key: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const { marketStatus, marketplace, pluginViews, working, setInstallTarget, setUninstallTarget, setActiveView } = props;
  return (
    <aside className="border-r bg-background p-4">
      <Card className="h-full"><CardHeader><CardTitle>LVIS Plugins</CardTitle><CardDescription>마켓플레이스</CardDescription></CardHeader>
        <CardContent className="space-y-3"><div className="text-xs text-muted-foreground">{marketStatus}</div>
          <ScrollArea className="h-[calc(100vh-180px)] pr-2"><div className="space-y-2">
            {marketplace.map((pl) => (
              <Card key={pl.id} className={`border-muted ${pl.isManaged ? "bg-muted/40" : ""}`}><CardContent className="space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium flex items-center gap-1">
                    {pl.isManaged ? <span title="관리형 플러그인 — 회사 IT가 배포/관리 (제거 불가)">🔒</span> : null}
                    {pl.name}
                  </div>
                  <Badge variant={pl.installed ? "default" : "secondary"}>{pl.installed ? "설치됨" : "미설치"}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{pl.description}</p>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => setInstallTarget(pl)} disabled={working || pl.isManaged} className="h-8" title={pl.isManaged ? "관리형 플러그인은 재설치할 수 없습니다" : ""}>{pl.installed ? "재설치" : "설치"}</Button>
                  {pl.installed ? <Button size="sm" variant="destructive" onClick={() => setUninstallTarget(pl)} disabled={working || pl.isManaged} className="h-8" title={pl.isManaged ? "관리형 플러그인은 제거할 수 없습니다" : ""}>제거</Button> : null}
                  <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="outline" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { const t = pluginViews.find((x) => x.pluginId === pl.id); if (t) setActiveView(toViewKey(t)); }}>UI 열기</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent></Card>
            ))}
          </div></ScrollArea>
        </CardContent>
      </Card>
    </aside>
  );
}
