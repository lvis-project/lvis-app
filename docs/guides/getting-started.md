# Getting Started

Status: Active English default. A Korean mirror of this page is kept in step with it, but this page must be usable on its own.

Korean mirror: [docs/ko/guides/getting-started.md](../ko/guides/getting-started.md).

## What This Page Owns

This page owns the clean-checkout setup path for running, testing, and understanding the desktop app. Use it as the first review surface when changing this area, and update the Korean mirror in the same commit.

## Current Operating Contract

- English is the default review and contributor language for this app surface.
- The document must name the behavior that still matters today, the code or test locations that enforce it, and the conditions that make the note stale.
- Source files and tests are authoritative when this prose and implementation disagree.
- The Korean mirror states the same things as this page; when the two disagree, this page and the source are authoritative.

## Clean-Checkout Setup

```bash
bun install
bun run build
bun run start
```

Bun is the package manager, but Electron and some build scripts call the system `node` CLI directly, so both must be on the path. Windows-specific setup is in [Windows setup](./windows-setup.md).

## First Run: Connect A Provider

Nothing can answer until a provider is connected, so the first stop is **Settings → Model**.

1. Press **Add provider**. The new card appears directly above that button, in the order you added it, and scrolls into view.
2. Fill in the card's credentials. **Save lives on the card itself**, beside the fields it commits, and stays disabled until a field differs from what is already saved. A card collapsed with uncommitted input is marked unsaved rather than discarding it.
3. An **endpoint** field appears only where the endpoint is yours to supply: the generic OpenAI-compatible provider, Azure AI Foundry, and the self-hosted set (Ollama, LM Studio, LiteLLM). Providers with a fixed endpoint, and providers installed from a marketplace preset, do not show one.
4. The OpenAI row offers three ways in, in one button row: **Sign in in browser**, **Use device code**, and **Use API key**. The last reveals the key field on the card; the first two are opened by the main process, and no sign-in URL or account token reaches the settings page.
5. The model list is fetched from the provider rather than read from a bundled list, and the card states which sync state it is in — synced with a count, syncing, "set an API key to sync the model list", "could not sync; showing the last catalogue that arrived", or "could not sync". A model the endpoint no longer lists is called out, because requests are rejected until another one is chosen and saved.

With a provider connected you can open a conversation and split the main area into up to four tiles from the tile header's split control. [Tiled chat groups](../design/tiled-chat-groups.md) records what a tile owns.

## Implementation Anchors

- `package.json`
- `src/plugins/`
- `src/main/`
- `src/ui/renderer/`
- `src/ui/renderer/tabs/LlmTab.tsx`
- `src/ui/renderer/tabs/SubscriptionProvidersSection.tsx`

## Update Checklist

- State whether the document is active, implemented, superseded, or historical before adding new detail.
- Keep links relative to the current file depth; mirrored files under `docs/ko` need different paths from default docs.
- Add or update tests when a documented behavior is enforced by code.
- Remove template language and stale plan wording instead of carrying it forward.

## Related Entry Points

- [LVIS Project Documentation](../README.md)

## Review Notes

This English page should let a reviewer understand scope, risk, and validation on its own. When it changes, the Korean mirror changes with it.
