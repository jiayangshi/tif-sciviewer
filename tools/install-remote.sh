#!/usr/bin/env bash
# Copy the packaged .vsix to one or more SSH hosts and install it there.
#
#   ./tools/install-remote.sh gpu01 gpu02 cluster-login
#   VSIX=other.vsix ./tools/install-remote.sh gpu01
#
# Host names are whatever works with `ssh` - including Host aliases from
# ~/.ssh/config, which is what Remote-SSH uses too.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSIX="${VSIX:-$HERE/../tif-sciviewer.vsix}"
[ -f "$VSIX" ] || { echo "error: $VSIX not found. Run: npm run package" >&2; exit 2; }
[ $# -gt 0 ] || { echo "usage: $0 <ssh-host> [ssh-host ...]" >&2; exit 2; }

FAILED=()
for HOST in "$@"; do
  echo "=== $HOST ==="
  if scp -q "$VSIX" "$HOST:/tmp/" && \
     scp -q "$HERE/vscode-server-install.sh" "$HOST:/tmp/" && \
     ssh "$HOST" "bash /tmp/vscode-server-install.sh /tmp/$(basename "$VSIX") && rm -f /tmp/vscode-server-install.sh /tmp/$(basename "$VSIX")"; then
    echo "--- $HOST ok"
  else
    echo "--- $HOST FAILED" >&2
    FAILED+=("$HOST")
  fi
  echo
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "failed on: ${FAILED[*]}" >&2
  exit 1
fi
echo "all hosts done. Reload any open remote windows."
