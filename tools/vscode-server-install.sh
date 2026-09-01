#!/usr/bin/env bash
# Runs ON a remote host. Installs a .vsix into that host's VS Code Server.
#
#   ./vscode-server-install.sh tif-sciviewer.vsix
#
# Env:
#   VSCODE_SERVER_DIR   server data dir (default ~/.vscode-server; override if
#                       remote.SSH.serverInstallPath is set)
#   ALLOW_MANUAL=1      fall back to unpacking by hand when no server CLI exists
set -euo pipefail

VSIX="${1:-}"
[ -n "$VSIX" ] || { echo "usage: $0 <path-to.vsix>" >&2; exit 2; }
[ -f "$VSIX" ] || { echo "error: no such file: $VSIX" >&2; exit 2; }

ROOT="${VSCODE_SERVER_DIR:-$HOME/.vscode-server}"

if [ ! -d "$ROOT" ]; then
  cat >&2 <<EOF
error: $ROOT does not exist, so VS Code Server has never run on $(hostname).

Connect to this host once with Remote-SSH from your laptop. That downloads the
server, after which this script will work. There is no way to install an
extension into a server that is not there yet.
EOF
  exit 1
fi

# Two layouts exist depending on how the server was provisioned: Remote-SSH uses
# bin/<commit>/, the tunnel CLI uses cli/servers/<quality>-<commit>/. Newest wins.
find_cli() {
  # shellcheck disable=SC2012
  ls -dt "$ROOT"/bin/*/bin/code-server \
         "$ROOT"/cli/servers/*/server/bin/code-server 2>/dev/null | while read -r p; do
    [ -x "$p" ] && echo "$p"
  done
}

CLI="$(find_cli | head -n 1 || true)"

if [ -n "$CLI" ]; then
  echo "server CLI: $CLI"
  # --force replaces an already-installed copy of the same version, which is
  # what you want when re-deploying a build that kept its version number.
  "$CLI" --install-extension "$VSIX" --force
  echo
  echo "installed. Reload the VS Code window on this host to pick it up."
  exit 0
fi

if [ "${ALLOW_MANUAL:-0}" != "1" ]; then
  cat >&2 <<EOF
error: found $ROOT but no code-server binary inside it.

The server may be mid-download, or pruned after an update. Connect once with
Remote-SSH to restore it, then re-run.

To unpack the extension by hand anyway, re-run with ALLOW_MANUAL=1. That works,
but VS Code will not know the extension's origin and a server update may drop it.
EOF
  exit 1
fi

echo "no server CLI; unpacking by hand into $ROOT/extensions" >&2
command -v unzip >/dev/null || { echo "error: unzip not found" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$VSIX" -d "$TMP"
[ -f "$TMP/extension/package.json" ] || { echo "error: not a .vsix (no extension/package.json)" >&2; exit 1; }

read -r PUB NAME VER <<EOF
$(python3 -c "
import json,sys
d=json.load(open('$TMP/extension/package.json'))
print(d['publisher'], d['name'], d['version'])
" 2>/dev/null || echo "")
EOF
[ -n "${VER:-}" ] || { echo "error: could not read publisher/name/version (python3 missing?)" >&2; exit 1; }

DEST="$ROOT/extensions/$PUB.$NAME-$VER"
mkdir -p "$ROOT/extensions"
rm -rf "$DEST"
mv "$TMP/extension" "$DEST"
echo "unpacked to $DEST"
echo "Reload the VS Code window on this host. If it does not appear, the server"
echo "is caching $ROOT/extensions/extensions.json; delete that file and reload."
