import type { Preview } from "@storybook/react";
import React from "react";
import { BUNDLES, DEFAULT_BUNDLE_ID, findBundle } from "../src/ui/renderer/theme/bundles/index";
import { applyBundleToDocument } from "../src/ui/renderer/theme/resolve-theme";
import "../src/styles.css";

const themeBundleItems = BUNDLES.map((bundle) => ({
  value: bundle.id,
  title: `${bundle.name} (${bundle.shell})`,
}));

const preview: Preview = {
  globalTypes: {
    themeBundle: {
      name: "LVIS Theme",
      description: "LVIS theme bundle",
      toolbar: {
        icon: "paintbrush",
        items: themeBundleItems,
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    themeBundle: DEFAULT_BUNDLE_ID,
  },
  decorators: [
    (Story, context) => {
      const selected = typeof context.globals.themeBundle === "string"
        ? context.globals.themeBundle
        : DEFAULT_BUNDLE_ID;
      const fallbackBundle = findBundle(DEFAULT_BUNDLE_ID) ?? BUNDLES[0]!;
      const bundle = findBundle(selected) ?? fallbackBundle;
      applyBundleToDocument(bundle);

      return React.createElement(
        "div",
        { className: "min-h-screen bg-background text-foreground" },
        React.createElement(Story),
      );
    },
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: "dark",
      values: [
        { name: "dark", value: "#0f0f10" },
        { name: "light", value: "#ffffff" },
      ],
    },
  },
};

export default preview;
