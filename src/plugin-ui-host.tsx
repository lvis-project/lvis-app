import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";

export type PluginUiExtensionView = {
  pluginId: string;
  extension: {
    id: string;
    slot: "sidebar";
    kind: "embedded-module" | "embedded-page" | "info-card";
    displayName?: string;
    title: string;
    description?: string;
    defaults?: Record<string, unknown>;
    entry?: string;
    exportName?: string;
    page?: string;
  };
  entryUrl?: string;
};

export type PluginUiBridge = {
  callPluginMethod: (method: string, payload?: unknown) => Promise<unknown>;
  askInHomeChat: (question: string) => Promise<void>;
  addTask: (task: { title: string; source: string; sourceRef?: string; priority?: string; description?: string; dueAt?: string }) => Promise<unknown>;
};

export type PluginUiMountContext = {
  root: HTMLElement;
  bridge: PluginUiBridge;
  extension: PluginUiExtensionView["extension"];
};

type PluginUiMountResult = void | (() => void);
type PluginUiMountFn = (context: PluginUiMountContext) => PluginUiMountResult | Promise<PluginUiMountResult>;
type LoadedPluginUiModule = {
  moduleNamespace: unknown;
  revoke?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function loadPluginUiModule(view: PluginUiExtensionView): Promise<LoadedPluginUiModule> {
  const entryUrl = view.entryUrl;
  if (!entryUrl) {
    throw new Error("UI 모듈 엔트리를 찾을 수 없습니다.");
  }

  if (!entryUrl.startsWith("file:")) {
    return {
      moduleNamespace: (await import(/* @vite-ignore */ entryUrl)) as unknown,
    };
  }

  const moduleSource = await window.lvisApi.readPluginUiModule(view.pluginId, view.extension.id);
  const blob = new Blob([`${moduleSource}\n//# sourceURL=${entryUrl}`], {
    type: "text/javascript",
  });
  const moduleUrl = URL.createObjectURL(blob);

  try {
    return {
      moduleNamespace: (await import(/* @vite-ignore */ moduleUrl)) as unknown,
      revoke: () => URL.revokeObjectURL(moduleUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(moduleUrl);
    throw error;
  }
}

function resolvePluginMount(moduleNamespace: unknown, exportName?: string): PluginUiMountFn | null {
  if (!isRecord(moduleNamespace)) return null;

  const candidates: unknown[] = [];
  if (exportName) {
    candidates.push(moduleNamespace[exportName]);
  }
  candidates.push(moduleNamespace.mount);
  candidates.push(moduleNamespace.default);

  const defaultExport = moduleNamespace.default;
  if (isRecord(defaultExport)) {
    candidates.push(defaultExport.mount);
  }

  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as PluginUiMountFn;
    }
  }
  return null;
}

function getPluginViewLabel(item: PluginUiExtensionView): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}

export function PluginUiHostView({
  view,
  callPluginMethod,
  onAskInHomeChat,
  onAddTask,
}: {
  view: PluginUiExtensionView | null;
  callPluginMethod: (method: string, payload?: unknown) => Promise<unknown>;
  onAskInHomeChat: (question: string) => Promise<void>;
  onAddTask: PluginUiBridge["addTask"];
}) {
  const mountRootRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const bridge = useMemo<PluginUiBridge>(
    () => ({
      callPluginMethod,
      askInHomeChat: onAskInHomeChat,
      addTask: onAddTask,
    }),
    [callPluginMethod, onAskInHomeChat, onAddTask],
  );

  useEffect(() => {
    const root = mountRootRef.current;
    if (!root) return;
    root.replaceChildren();

    if (!view) {
      setLoading(false);
      setErrorText("플러그인 뷰를 찾을 수 없습니다.");
      return;
    }

    if (view.extension.kind === "embedded-page") {
      setLoading(false);
      setErrorText("구형 iframe UI 형식은 지원되지 않습니다. entry 기반 모듈 UI를 사용하세요.");
      return;
    }

    const entryUrl = view.entryUrl;
    if (!entryUrl) {
      setLoading(false);
      setErrorText("UI 모듈 엔트리를 찾을 수 없습니다.");
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | undefined;
    let revokeModuleUrl: (() => void) | undefined;
    setLoading(true);
    setErrorText(null);

    void (async () => {
      try {
        const loadedModule = await loadPluginUiModule(view);
        if (disposed) {
          loadedModule.revoke?.();
          return;
        }
        revokeModuleUrl = loadedModule.revoke;

        const mount = resolvePluginMount(loadedModule.moduleNamespace, view.extension.exportName);
        if (!mount) {
          throw new Error(`mount 함수를 찾을 수 없습니다 (plugin=${view.pluginId}, view=${view.extension.id})`);
        }

        const maybeCleanup = await mount({
          root,
          bridge,
          extension: view.extension,
        });
        if (typeof maybeCleanup === "function") {
          cleanup = maybeCleanup;
        }
        if (!disposed) {
          setLoading(false);
          setErrorText(null);
        }
      } catch (error) {
        if (disposed) return;
        setLoading(false);
        setErrorText(`UI 로딩 실패: ${(error as Error).message}`);
      }
    })();

    return () => {
      disposed = true;
      if (cleanup) cleanup();
      if (revokeModuleUrl) revokeModuleUrl();
      root.replaceChildren();
    };
  }, [bridge, view]);

  return (
    <Card className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <CardHeader>
        <CardTitle>{view ? getPluginViewLabel(view) : "플러그인 UI"}</CardTitle>
        <CardDescription>{view?.extension.description ?? "플러그인 화면을 로딩합니다."}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <div className="relative h-full w-full overflow-hidden rounded-md border bg-card">
          {loading ? (
            <div className="absolute inset-x-0 top-0 z-10 px-3 py-2 text-xs text-muted-foreground">
              로딩 중...
            </div>
          ) : null}
          {errorText ? <div className="px-3 py-2 text-xs text-destructive">{errorText}</div> : null}
          <div ref={mountRootRef} className="h-full overflow-auto p-3" />
        </div>
      </CardContent>
    </Card>
  );
}
