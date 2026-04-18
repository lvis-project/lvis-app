# @lvis/plugin-sdk

Type-only SDK for LVIS plugin authors. Import the host contract in one line:

```ts
import type {
  RuntimePluginFactory,
  PluginHostApi,
  PluginManifest,
} from "@lvis/plugin-sdk";

const createPlugin: RuntimePluginFactory = ({ pluginId, hostApi, config }) => ({
  handlers: {
    hello: async () => "world",
  },
});

export default createPlugin;
```

No runtime code — the package emits `.d.ts` declarations only (`emitDeclarationOnly: true`, no `main` export). Plugin repos add `@lvis/plugin-sdk` to their `devDependencies` and rely on the host repo publishing updates when the plugin contract changes.
