# lvisai.xyz

Unified web home for [LVIS AI](https://lvisai.xyz) — marketing landing (`/`) and the
user guide (`/docs/*`) in a single Next.js 14 static-export app.

- Design system: see `DESIGN.md` (marketplace-aligned neutral system)
- Deployment: Cloudflare Pages via wrangler direct upload — see `DEPLOY.md`
- `docs.lvisai.xyz` is a 301 redirect shim to `lvisai.xyz/docs/*` (see `infra/docs-redirect/`)

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static export → out/
npm run preview  # serve out/ locally
```

## Structure

```
app/            landing (/) + docs routes (/docs/**)
components/     landing/*, docs/*, motion/*, ui/*
lib/            navigation, search-index, roadmap, screenshots, downloads
public/         favicon, lvis-mark, screenshots/
infra/          docs-redirect shim for the legacy docs domain
```

## Desktop packages

Download buttons link directly to the latest GitHub Release assets:

```
https://github.com/lvis-project/lvis-app/releases/latest/download/LVIS-latest-mac-arm64.dmg
https://github.com/lvis-project/lvis-app/releases/latest/download/LVIS-latest-windows-x64-setup.exe
https://github.com/lvis-project/lvis-app/releases/latest/download/LVIS-latest-linux-x86_64.AppImage
```

The landing page auto-detects the visitor's OS and highlights the matching card.
