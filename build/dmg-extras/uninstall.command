#!/bin/bash
# LVIS macOS uninstall helper.
# Removes /Applications/LVIS.app and, only when the user explicitly chooses it,
# local LVIS data such as ~/.lvis and Electron userData/cache files.

set -u
trap 'echo; echo "Aborted."; exit 130' INT

APP="/Applications/LVIS.app"
APP_NAME="LVIS"
APP_SUPPORT="$HOME/Library/Application Support/LVIS"
LVIS_HOME="$HOME/.lvis"

DATA_PATHS=(
  "$APP_SUPPORT"
  "$LVIS_HOME"
  "$HOME/Library/Caches/LVIS"
  "$HOME/Library/Caches/xyz.lvisai.app"
  "$HOME/Library/Logs/LVIS"
  "$HOME/Library/Preferences/xyz.lvisai.app.plist"
  "$HOME/Library/Saved Application State/xyz.lvisai.app.savedState"
  "$HOME/Library/WebKit/LVIS"
)

confirm() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer || true
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

remove_path() {
  local path="$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  if rm -rf "$path" 2>/dev/null; then
    echo "Removed: $path"
    return 0
  fi
  echo "Permission required: $path"
  sudo rm -rf "$path"
  echo "Removed: $path"
}

clear
echo "================================================"
echo "  LVIS macOS Uninstaller"
echo "================================================"
echo ""

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "Requesting LVIS to quit..."
  osascript -e 'tell application "LVIS" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

if [ -d "$APP" ]; then
  if confirm "Remove LVIS.app from /Applications?"; then
    remove_path "$APP"
    if command -v /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister >/dev/null 2>&1; then
      /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" >/dev/null 2>&1 || true
    fi
  else
    echo "Skipped app removal."
  fi
else
  echo "LVIS.app was not found at $APP."
fi

echo ""
echo "Local data is preserved by default."
echo "This includes memories, plugins, secrets, settings, caches, and logs."
if confirm "Also remove local LVIS data?"; then
  for path in "${DATA_PATHS[@]}"; do
    remove_path "$path"
  done
else
  echo "Skipped local data removal."
fi

echo ""
echo "LVIS uninstall helper finished."
read -r -p "Press Enter to close..." _ || true
exit 0
