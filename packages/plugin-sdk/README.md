# @lvis/plugin-sdk

Source/type-only SDK for LVIS plugin authors. The SDK is the plugin contract
surface only; it does not ship runtime code, build output, lifecycle hooks, or
marketplace trust keys.

```ts
import type {
  RuntimePluginFactory,
  PluginHostApi,
  PluginManifest,
} from "@lvis/plugin-sdk";

const createPlugin: RuntimePluginFactory = ({ hostApi }) => ({
  handlers: {
    hello: async () => "world",
  },
});

export default createPlugin;
```

## Install

During pre-npm development, consume the SDK as a normal Git dependency:

```json
{
  "devDependencies": {
    "@lvis/plugin-sdk": "github:lvis-project/lvis-plugin-sdk#v2.0.0"
  }
}
```

After npm publication, use a normal semver range:

```json
{
  "devDependencies": {
    "@lvis/plugin-sdk": "^2.0.0"
  }
}
```

No submodule is required.

## Trust model

Marketplace signing keys are intentionally not part of this SDK. LVIS follows
the commercial IDE/browser marketplace model:

- `lvis-marketplace` validates and signs uploaded plugin artifacts.
- `lvis-app` owns the marketplace trust anchors and verifies signed artifacts
  during install/update.
- Plugin repos use this SDK only for authoring types and manifest contracts.

## Tag policy

- `v2.0.0+` tags are immutable release points.
- Consumers should pin a specific tag while the SDK is distributed by GitHub.
- Moving major tags may be introduced later once repository tag protection is
  available.
