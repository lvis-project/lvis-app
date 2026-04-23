import { useEffect } from "react";

type ErudaApi = {
  init: (options?: unknown) => void;
};

let erudaBooted = false;

export function DevConsoleToggle() {
  const enabled = window.lvis?.env?.enableDevConsole === true;
  useEffect(() => {
    if (!enabled || erudaBooted) return;
    let alive = true;
    void import("eruda").then((mod) => {
      if (!alive || erudaBooted) return;
      const eruda = (mod.default ?? mod) as unknown as ErudaApi;
      eruda.init({
        autoScale: true,
        useShadowDom: true,
      });
      erudaBooted = true;
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  if (!enabled) return null;
  return null;
}