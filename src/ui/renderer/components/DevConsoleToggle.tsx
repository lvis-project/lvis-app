import { useCallback, useRef, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { Button } from "../../../components/ui/button.js";

type ErudaApi = {
  init: (options?: unknown) => void;
  show?: () => void;
  hide?: () => void;
};

let erudaBooted = false;
let erudaInstance: ErudaApi | null = null;

export function DevConsoleToggle() {
  const enabled = window.lvis?.env?.enableDevConsole === true;
  const [open, setOpen] = useState(false);
  const loadingRef = useRef<Promise<ErudaApi> | null>(null);

  const ensureEruda = useCallback(async (): Promise<ErudaApi> => {
    if (erudaInstance) return erudaInstance;
    if (!loadingRef.current) {
      loadingRef.current = import("eruda").then((mod) => {
        const eruda = (mod.default ?? mod) as unknown as ErudaApi;
        if (!erudaBooted) {
          eruda.init({
            autoScale: true,
            useShadowDom: true,
          });
          eruda.hide?.();
          erudaBooted = true;
        }
        erudaInstance = eruda;
        return eruda;
      });
    }
    return loadingRef.current;
  }, []);

  const handleToggle = useCallback(async () => {
    const eruda = await ensureEruda();
    setOpen((prev) => {
      const next = !prev;
      if (next) eruda.show?.();
      else eruda.hide?.();
      return next;
    });
  }, [ensureEruda]);

  if (!enabled) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="fixed bottom-4 right-4 z-[80] h-9 gap-1 rounded-full bg-background/95 px-3 shadow-lg backdrop-blur"
      aria-label={open ? "개발 콘솔 숨기기" : "개발 콘솔 열기"}
      title={open ? "개발 콘솔 숨기기" : "개발 콘솔 열기"}
      onClick={() => { void handleToggle(); }}
    >
      <TerminalSquare className="h-4 w-4" />
      Dev
    </Button>
  );
}
