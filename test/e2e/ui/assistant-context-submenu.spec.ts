import { test, expect } from "./fixtures";

/**
 * Regression: the InputActionBar 의 role(=assistant context) 버튼의 서브메뉴
 * (Agent / Skills / Persona) 가 채팅 패널 좌측에서 잘리는 현상.
 *
 * Root cause: shadcn 의 DropdownMenuContent 기본 className 인
 * `overflow-hidden` 이, floating-ui 가 transform 으로 positioning 한 popper
 * 컨테이너에 적용되어 fixed-positioned 자손(SubContent) 의 containing block
 * 을 만들고, collision flip 으로 좌측에 열린 서브메뉴를 잘라냈다.
 *
 * Fix: 메인 DropdownMenuContent 에 `overflow-visible` 를 오버라이드 + 모든
 * SubContent 에 collisionPadding 부여.
 *
 * 검증 전략: 가시적 픽셀 비교 대신 DOM geometry assertion 으로 안정성 확보.
 *   1. 충분히 넓은 윈도우에서 서브메뉴가 viewport 안에 완전히 들어가야 한다.
 *   2. 서브메뉴는 항상 natural size 로 렌더되어야 한다 (overflow 로 0px 잘림 X).
 *   3. side flip(`data-side="left"`) 시에도 위 두 조건이 유지되어야 한다.
 */

const ROLE_BUTTON = '[data-testid="iab-assistant-context-button"]';

async function resizeWindow(
  app: { evaluate: (fn: (electron: typeof import("electron"), arg: { w: number; h: number }) => unknown, arg: { w: number; h: number }) => Promise<unknown> },
  width: number,
  height: number,
) {
  // Electron main-process eval: BrowserWindow API 로 윈도우 사이즈 강제.
  // app.evaluate 는 main process 에서 실행되므로 closure 변수 사용 불가 — args 로 전달.
  await app.evaluate(({ BrowserWindow }, { w, h }) => {
    const wins = BrowserWindow.getAllWindows();
    const main = wins.find((win) => !win.isDestroyed() && win.isVisible()) ?? wins[0];
    if (!main) return;
    main.setBounds({ x: 0, y: 0, width: w, height: h });
  }, { w: width, h: height });
}

test("Agent submenu renders within viewport and is not clipped", async ({ app, mainWindow }) => {
  await resizeWindow(app as never, 1280, 800);
  // give the renderer a tick to react to resize
  await mainWindow.waitForTimeout(200);

  const trigger = mainWindow.locator(ROLE_BUTTON);
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  await trigger.click();

  const agentTrigger = mainWindow.getByRole("menuitem", { name: /Agent/ });
  await agentTrigger.waitFor({ state: "visible", timeout: 5_000 });
  await agentTrigger.hover();

  const submenuFirstItem = mainWindow.getByRole("menuitem", { name: /기본 에이전트/ });
  await submenuFirstItem.waitFor({ state: "visible", timeout: 5_000 });

  const info = await mainWindow.evaluate(() => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    const sub = menus[menus.length - 1] as HTMLElement;
    const r = sub.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      w: r.width,
      h: r.height,
      side: sub.getAttribute("data-side"),
    };
  });

  // 1. natural size (overflow:hidden 으로 0 으로 잘리지 않음)
  expect(info.w).toBeGreaterThan(100);
  expect(info.h).toBeGreaterThan(20);
  // 2. viewport 안에 들어감
  expect(info.left).toBeGreaterThanOrEqual(0);
  expect(info.top).toBeGreaterThanOrEqual(0);
  expect(info.right).toBeLessThanOrEqual(info.vw);
  expect(info.bottom).toBeLessThanOrEqual(info.vh);
});

test("Skills submenu renders within viewport and is not clipped", async ({ app, mainWindow }) => {
  await resizeWindow(app as never, 1280, 800);
  await mainWindow.waitForTimeout(200);

  const trigger = mainWindow.locator(ROLE_BUTTON);
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  await trigger.click();

  const skillsTrigger = mainWindow.getByRole("menuitem", { name: /Skills/ });
  await skillsTrigger.waitFor({ state: "visible", timeout: 5_000 });
  await skillsTrigger.hover();

  const submenuFirstItem = mainWindow.getByRole("menuitem", { name: /스킬 해제/ });
  await submenuFirstItem.waitFor({ state: "visible", timeout: 5_000 });

  const info = await mainWindow.evaluate(() => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    const sub = menus[menus.length - 1] as HTMLElement;
    const r = sub.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      w: r.width,
      h: r.height,
    };
  });

  expect(info.w).toBeGreaterThan(100);
  expect(info.h).toBeGreaterThan(20);
  expect(info.left).toBeGreaterThanOrEqual(0);
  expect(info.right).toBeLessThanOrEqual(info.vw);
});

test("Persona submenu renders within viewport and is not clipped", async ({ app, mainWindow }) => {
  await resizeWindow(app as never, 1280, 800);
  await mainWindow.waitForTimeout(200);

  const trigger = mainWindow.locator(ROLE_BUTTON);
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  await trigger.click();

  const personaTrigger = mainWindow.getByRole("menuitem", { name: /Persona/ });
  await personaTrigger.waitFor({ state: "visible", timeout: 5_000 });
  await personaTrigger.hover();

  // Persona 의 서브메뉴는 role-presets 의 정확한 이름에 의존하지 않으려고
  // role=menu 의 마지막 인스턴스(=서브메뉴) 의 geometry 만 본다.
  const menus = mainWindow.locator('[role="menu"]');
  await expect(menus).toHaveCount(2, { timeout: 5_000 });

  const info = await mainWindow.evaluate(() => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    const sub = menus[menus.length - 1] as HTMLElement;
    const r = sub.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      w: r.width,
      h: r.height,
    };
  });

  expect(info.w).toBeGreaterThan(50);
  expect(info.h).toBeGreaterThan(20);
  expect(info.left).toBeGreaterThanOrEqual(0);
  expect(info.right).toBeLessThanOrEqual(info.vw);
});
