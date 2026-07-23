export interface NativeWindowCoordinator {
  showOrCreateMainWindow: (reason: string) => void;
  refreshNativeChrome: () => void;
}

let coordinator: NativeWindowCoordinator | null = null;

/** Configure the native window/menu/tray composition boundary exactly once. */
export function configureNativeWindowCoordinator(next: NativeWindowCoordinator): void {
  if (coordinator) throw new Error("native-window-coordinator-already-configured");
  coordinator = next;
}

function requireCoordinator(): NativeWindowCoordinator {
  if (!coordinator) throw new Error("native-window-coordinator-not-configured");
  return coordinator;
}

export function requestShowOrCreateMainWindow(reason: string): void {
  requireCoordinator().showOrCreateMainWindow(reason);
}

export function requestNativeChromeRefresh(): void {
  requireCoordinator().refreshNativeChrome();
}

/** @internal test-only reset for isolated module-state tests. */
export function resetNativeWindowCoordinatorForTests(): void {
  coordinator = null;
}
