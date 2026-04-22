import { useEffect } from "react";

type ErudaApi = {
  init: (options?: unknown) => void;
  hide?: () => void;
};

let erudaBooted = false;

export function DevConsoleToggle() {
  useEffect(() => {
    if (!window.lvis?.env?.enableDevConsole || erudaBooted) return;
    let alive = true;
    void import("eruda").then((mod) => {
      if (!alive || erudaBooted) return;
      const eruda = (mod.default ?? mod) as unknown as ErudaApi;
      eruda.init({
        autoScale: true,
        useShadowDom: true,
      });
      eruda.hide?.();
      erudaBooted = true;
    });
    return () => {
      alive = false;
    };
  }, []);

  return null;
}
