#!/usr/bin/env bash
# From the non-root WSL distro user. Build the production lib and panel bundle in Windows first:
# pnpm.cmd build
# node scripts/verify-panel-db-isolation.mjs build node_modules/.cache/q22-panel/panel.js
# wsl.exe -e bash scripts/verify-panel-db-isolation-wsl.sh
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
bundle="$PWD/node_modules/.cache/q22-panel/panel.js"
browser="${1:-$HOME/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell}"
wsl="${Q22_WSL_EXE:-/mnt/c/Windows/System32/wsl.exe}"
node_bin="${Q22_LINUX_NODE:-$(command -v node || true)}"
node_bin="${node_bin:-$HOME/.local/bin/node}"
temp_dir="$(mktemp -d /tmp/orchestra-q22.XXXXXXXX)"
service_pid=
cleanup() {
  if [[ -n "$service_pid" ]]; then
    kill "$service_pid" 2>/dev/null || true
    wait "$service_pid" 2>/dev/null || true
  fi
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

[[ "$(id -u)" != 0 ]]
[[ -x "$node_bin" && -x "$browser" ]]
chmod 0755 "$temp_dir"
cp -L -- "$node_bin" "$temp_dir/node"
cp -r -- "$(dirname -- "$browser")" "$temp_dir/browser"
chmod -R a+rX "$temp_dir/browser"
probe="$PWD/scripts/verify-panel-db-isolation.mjs"
log="$temp_dir/service.log"
"$temp_dir/node" "$probe" service "$temp_dir" "$bundle" >"$log" 2>&1 &
service_pid=$!
for ((i=0; i<100; i++)); do
  [[ -s "$temp_dir/ready.json" ]] && break
  kill -0 "$service_pid" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 0.1
done
[[ -s "$temp_dir/ready.json" ]] || { cat "$log"; exit 1; }
if ! "$wsl" -u nobody --cd /tmp -e "$temp_dir/node" "$probe" panel "$temp_dir/browser/${browser##*/}" <"$temp_dir/ready.json"; then
  cat "$log"
  exit 1
fi
if ! wait "$service_pid"; then
  cat "$log"
  exit 1
fi
service_pid=
cat "$log"
