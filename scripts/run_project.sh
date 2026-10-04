#!/usr/bin/env bash
# Start (or restart) a project's VS Code workspace and its auto-start tasks.
#   scripts/run_project.sh <instance> [--dry-run]
# Reads workspace, target ports and visualizer ports from instances.json. A re-run
# kills the listeners on those ports, closes the old VS Code window for the folder,
# then reopens it so the folderOpen tasks start fresh. Browser opens on cold start only.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="${1:-}"; dry=0; [ "${2:-}" = "--dry-run" ] && dry=1
[ -n "$name" ] || { echo "usage: $0 <instance> [--dry-run]" >&2; exit 2; }

read -r workspace dash ports < <(python3 - "$ROOT/instances.json" "$name" <<'PY'
import json, sys
from urllib.parse import urlparse
for i in json.load(open(sys.argv[1]))["instances"]:
    if i["name"] == sys.argv[2]:
        ports = [i["backend_port"], i["frontend_port"], *i.get("target_ports", [])]
        if i.get("target_url"):
            ports.append(urlparse(i["target_url"]).port)
        print(i["workspace"], i["frontend_port"], ",".join(str(p) for p in dict.fromkeys(p for p in ports if p)))
        break
else:
    sys.exit(1)
PY
) || { echo "unknown instance '$name'" >&2; exit 1; }

listeners() { ss -ltnpH 2>/dev/null | awk -v p=":$1\$" '$4 ~ p' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u; }
win_ids() { command -v wmctrl >/dev/null && wmctrl -l | awk -v w="$(basename "$workspace")" '$0 ~ w && $0 ~ /Visual Studio Code/ {print $1}'; }

restarted=0
for port in ${ports//,/ }; do
    pids="$(listeners "$port")"
    [ -n "$pids" ] || continue
    restarted=1
    echo "port $port: pids $(echo $pids)"
    [ $dry -eq 1 ] || { kill $pids 2>/dev/null; sleep 1; kill -9 $(listeners "$port") 2>/dev/null; }
done

if [ $dry -eq 1 ]; then echo "dry-run: workspace=$workspace ports=$ports restart=$restarted"; exit 0; fi

if [ $restarted -eq 1 ]; then
    if command -v wmctrl >/dev/null && [ -n "$(win_ids)" ]; then
        for id in $(win_ids); do wmctrl -ic "$id"; done
        for _ in $(seq 1 15); do [ -z "$(win_ids)" ] && break; sleep 1; done
        if [ -n "$(win_ids)" ]; then
            echo "VS Code window still open (unsaved changes?). Close it, then run again." >&2
            exit 1
        fi
    else
        echo "Servers stopped. Cannot close the VS Code window from here (needs wmctrl on X11)." >&2
        echo "In VS Code run 'Developer: Reload Window' (or close the window) and the tasks restart." >&2
    fi
fi

code "$workspace"
if [ $restarted -eq 0 ]; then
    ( for _ in $(seq 1 90); do
          if curl -s -o /dev/null "http://127.0.0.1:$dash"; then xdg-open "http://127.0.0.1:$dash" >/dev/null 2>&1; break; fi
          sleep 1
      done ) >/dev/null 2>&1 &
fi
