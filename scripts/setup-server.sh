#!/usr/bin/env bash
# setup-server.sh — download a vanilla Minecraft server.jar into ./server for local dev.
#
# The server.jar is Mojang-licensed and is intentionally NOT bundled with this repo.
# This script fetches it from Mojang's official servers, so it needs network access to
# *.mojang.com (which is blocked in some sandboxed environments).
#
# Running it writes eula.txt with eula=true — i.e. you accept Mojang's EULA
# (https://www.minecraft.net/en-us/eula). Don't run it if you don't.
#
# Usage: scripts/setup-server.sh [version]   (default: 1.21.11)
set -euo pipefail

VERSION="${1:-1.21.11}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
MANIFEST="https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"

command -v curl >/dev/null    || { echo "ERROR: curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 is required (JSON parsing)" >&2; exit 1; }

echo ":: Resolving Minecraft $VERSION server jar from Mojang..."
VERSION_URL="$(curl -fsSL "$MANIFEST" | python3 -c "
import sys, json
m = json.load(sys.stdin)
v = next((x for x in m['versions'] if x['id'] == '$VERSION'), None)
if not v: sys.exit('version $VERSION not found in manifest')
print(v['url'])
")"

JAR_URL="$(curl -fsSL "$VERSION_URL" | python3 -c "
import sys, json
print(json.load(sys.stdin)['downloads']['server']['url'])
")"

mkdir -p "$SERVER_DIR"
echo ":: Downloading server.jar ..."
curl -fsSL "$JAR_URL" -o "$SERVER_DIR/server.jar"

echo "eula=true" > "$SERVER_DIR/eula.txt"
if [[ ! -f "$SERVER_DIR/server.properties" ]]; then
  cat > "$SERVER_DIR/server.properties" <<'EOF'
server-port=25565
online-mode=false
gamemode=survival
difficulty=peaceful
level-name=world
EOF
fi

echo ":: Done. Start the server with:"
echo "   cd server && java -Xms1G -Xmx2G -jar server.jar nogui"
