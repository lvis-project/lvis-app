#!/bin/bash
# LVIS macOS 설치 도우미 / LVIS macOS install helper
# Removes macOS Gatekeeper quarantine from /Applications/LVIS.app so
# this unsigned internal build can be launched without the
# "Apple cannot verify..." dialog. See README.txt next to this file.

set -u
# Honor Ctrl-C even when interactive `read` is active. Without this the
# `|| true` fallbacks on `read` would swallow SIGINT and the script would
# fall through to `open` instead of aborting.
trap 'echo; echo "Aborted."; exit 130' INT

APP="/Applications/LVIS.app"

clear
echo "================================================"
echo "  LVIS macOS Setup"
echo "================================================"
echo ""

if [ ! -d "$APP" ]; then
  echo "❌ LVIS.app not found at $APP"
  echo ""
  echo "먼저 LVIS.app 을 Applications 폴더로 드래그한 후"
  echo "이 스크립트를 다시 실행하세요."
  echo ""
  echo "Please drag LVIS.app to the Applications folder"
  echo "first, then run this script again."
  echo ""
  read -r -p "Press Enter to close..." _ || true
  exit 1
fi

echo "📦 Found: $APP"
echo ""
echo "🔓 Checking Gatekeeper quarantine..."
if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  if xattr -dr com.apple.quarantine "$APP" 2>/dev/null; then
    echo "✅ Quarantine removed."
  else
    echo "⚠️  xattr 제거 실패 — 다음 명령을 Terminal 에서 직접 실행해보세요:"
    echo "   xattr removal failed. Run this in Terminal manually:"
    echo ""
    echo "   sudo xattr -dr com.apple.quarantine \"$APP\""
    echo ""
    read -r -p "Press Enter to continue..." _ || true
  fi
else
  echo "✅ 이미 깨끗합니다 / Already clean (no quarantine attribute)."
fi
echo ""
echo "🚀 Launching LVIS..."
if open "$APP"; then
  echo ""
  echo "이 창은 닫으셔도 됩니다. / You can close this window."
else
  echo ""
  echo "❌ 실행 실패. Applications 폴더에서 LVIS 를 직접 더블클릭하세요."
  echo "   Launch failed. Open LVIS manually from Applications."
fi
sleep 2
exit 0
