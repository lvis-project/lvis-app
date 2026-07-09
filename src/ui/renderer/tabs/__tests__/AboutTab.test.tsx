/**
 * AboutTab — after the settings IA restructure the former General tab was
 * renamed to About and holds ONLY the System Info block (OS / app version /
 * tech stack / data path). Account, workspace stats, and auth management moved
 * to the Model + Usage surfaces.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AboutTab } from "../AboutTab.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

const GENERAL_APP_INFO = {
  version: "0.2.3",
  electronVersion: "41.6.1",
  nodeVersion: "22.4.0",
  chromeVersion: "131.0.6778.0",
  v8Version: "13.1.201.13",
  platform: "darwin",
  arch: "arm64",
  userDataPath: "/Users/test/Library/Application Support/LVIS",
};

function aboutTabApi(): LvisApi {
  const { api } = makeMockLvisApi({ appInfo: GENERAL_APP_INFO });
  return api as unknown as LvisApi;
}

describe("AboutTab (System Info)", () => {
  it("renders the resolved app version + data path", async () => {
    const api = aboutTabApi();
    const { findByTestId, findByText } = render(<AboutTab api={api} />);
    const version = await findByTestId("general-tab-app-version");
    await waitFor(() => expect(version.textContent).toContain("v0.2.3"));
    // The data path is informational text; assert presence via the
    // user-facing copy.
    await findByText("/Users/test/Library/Application Support/LVIS");
  });

  it("renders the resolved 기반 기술 stack (Electron / Node / Chromium / V8)", async () => {
    const api = aboutTabApi();
    const { findByTestId } = render(<AboutTab api={api} />);
    const electron = await findByTestId("general-tab-stack-electron");
    const node = await findByTestId("general-tab-stack-node");
    const chrome = await findByTestId("general-tab-stack-chrome");
    const v8 = await findByTestId("general-tab-stack-v8");
    await waitFor(() => {
      expect(electron.textContent).toContain("41.6.1");
      expect(node.textContent).toContain("22.4.0");
      expect(chrome.textContent).toContain("131.0.6778.0");
      expect(v8.textContent).toContain("13.1.201.13");
    });
  });
});
