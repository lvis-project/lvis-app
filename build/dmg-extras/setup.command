#!/bin/bash
# LVIS macOS 설치 도우미 / LVIS macOS install helper
# Removes macOS Gatekeeper quarantine from /Applications/LVIS.app so
# this unsigned internal build can be launched without the
# "Apple cannot verify..." dialog. See README.txt next to this file.

set -u

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
echo "🔓 Removing Gatekeeper quarantine..."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "✅ Done."
echo ""
echo "🚀 Launching LVIS..."
open "$APP"
echo ""
echo "이 창은 닫으셔도 됩니다. / You can close this window."
sleep 2
exit 0
