# iongolem

An autonomous Minecraft bot built on [Mineflayer](https://github.com/PrismarineJS/mineflayer),
with decision-making driven by Claude. It perceives the world (block/biome scans, vision
raycasts, containers, chat), reasons about goals, and acts through a library of primitive
actions — mining, building, crafting, combat, navigation, and more.

## How it works

- **Mineflayer** speaks the Minecraft protocol and gives the bot eyes, hands, and a pathfinder.
- A pluggable **AI provider** (`ai-provider.js`) turns game context into decisions. This build
  ships **CLI-only**: it spawns the `claude` CLI (`claude -p`) as a persistent streaming
  subprocess, so it runs on your existing Claude subscription / browser login — **no API key
  required**. The CLI backend also gets `WebSearch`, `WebFetch`, and the bot's own query tools
  (via the bundled MCP server, `mcp-server.js`) for free.
- The provider interface is deliberately backend-agnostic (`init` / `send` / `abort` /
  `destroy`). A direct **Anthropic API** backend is stubbed in `ai-provider.js` for anyone who
  prefers API-key auth — implementing it is a contained, welcome contribution (see the note in
  that file about wiring the bot-query tools through a tool-use loop for parity).

## Requirements

- **Node.js** 18+ and npm
- The **`claude` CLI**, logged in:
  `npm i -g @anthropic-ai/claude-code && claude` (complete the one-time login)
- A **Minecraft Java server** to join (a local offline one is easiest — see below).
  Java 17+ is needed to run a vanilla server.

## Platform support

- **Linux / macOS** (incl. Apple Silicon): runs natively — no changes.
- **Windows:** run it under **WSL2** (it's Linux, so everything works). Native Windows is
  unsupported for now — the AI backend spawns the `claude` CLI with a large system prompt as a
  single argument, which exceeds Windows' command-line limit. WSL (or a future container setup)
  sidesteps it.

The only native dependency is `better-sqlite3` (embedded SQLite — no separate install). `npm
install` fetches a prebuilt binary for your OS + Node version, or compiles it if none matches
(needs standard build tools).

## Quick start

```bash
git clone https://github.com/arielvino/ion-golem.git && cd ion-golem
npm install
cp .env.example .env            # tweak if you like; defaults target a local server

# Option A — spin up a local offline server (downloads a Mojang-licensed jar):
scripts/setup-server.sh 1.21.11
cd server && java -Xms1G -Xmx2G -jar server.jar nogui   # leave running in another shell
cd ..

# Run the bot:
node bot.js --debug             # joins localhost:25565 as "BroDev", verbose logging
```

Talk to the bot in-game chat and it will respond and act. `--debug` just turns on verbose
logging and a dev-friendly default name; connection details come from `.env` either way.

## Configuration

All configuration is via environment variables (see `.env.example`). Defaults target a local
offline server with the CLI AI backend, so a fresh clone runs with zero edits.

| Variable      | Default             | Purpose                                                        |
|---------------|---------------------|---------------------------------------------------------------|
| `AI_PROVIDER` | `claude-code`       | AI backend. Only `claude-code` ships; `anthropic-api` is a stub. |
| `AI_MODEL`    | `sonnet`            | Model id (or alias) passed to the `claude` CLI; `sonnet` tracks the latest Sonnet. |
| `MC_HOST`     | `localhost`         | Server host to join.                                          |
| `MC_PORT`     | `25565`             | Server port.                                                  |
| `MC_VERSION`  | `1.21.11`           | Protocol version.                                             |
| `MC_USERNAME` | `Bro` / `BroDev`    | In-game username (`--debug` defaults to `BroDev`).           |
| `MC_AUTH`     | *(offline)*         | `offline` for cracked/LAN servers, `microsoft` for online-mode. |
| `IONGOLEM_DATA_DIR` | *(OS data dir)* | Base dir for per-bot state. Defaults to your OS user-data dir (see below). |

If `MC_HOST` is remote and an `http_proxy`/`https_proxy` env var is set, the Minecraft
connection is tunneled through it via HTTP CONNECT. Local hosts always connect directly.

### Where data is stored

Each bot's generated state (world memory `blocks.db`, logs, chat logs, task stack, block
memory) lives **outside the repo** by default, in your OS user-data directory under
`iongolem/<username>/`:

- **Linux:** `~/.local/share/iongolem/` (respects `$XDG_DATA_HOME`)
- **macOS:** `~/Library/Application Support/iongolem/`
- **Windows:** `%LOCALAPPDATA%\iongolem\`

So it survives re-cloning or upgrading, and works from a read-only/global install. The
resolved path is printed at startup (`[DATA] runtime dir: …`). To keep state next to the
code instead (convenient for hacking or a quick reset), set `IONGOLEM_DATA_DIR=./runtime`.

## Project layout

```
bot.js               entry point — Mineflayer setup, runtime dir, shutdown
src/
  core/              state, tick (abort/timing), shared utils
  ai/                AI message handling, provider (claude-code CLI; anthropic-api
                     stub), MCP server, per-turn context, system prompt/personalities
  engine/            main decision loop, autonomous behaviour, background tasks,
                     safety guard, task stack
  navigation/        pathfinding & movement, planner, low-level step primitives,
                     block queries, reachability, goals
  perception/        vision (ray casting), visibility survey, chunk scanning
  world/             persistent block/world memory (SQLite), block map, recipes
  actions/           primitive actions (mining, building, crafting, combat, …)
  config/            blocks, ranges, personalities, timings, safety
  lib/               blueprint parser, terminal colors
test/                unit tests (run: node --test)
scripts/             setup-server.sh and other helpers
server/              local server working dir (gitignored)
```

Per-bot generated state lives outside the repo by default (see [Where data is
stored](#where-data-is-stored)); point `IONGOLEM_DATA_DIR=./runtime` to keep it in-tree.

## Notes on the Minecraft server

`server.jar` is Mojang-licensed and is **not** included in this repo — `scripts/setup-server.sh`
downloads it from Mojang's official servers on demand and accepts the
[Minecraft EULA](https://www.minecraft.net/en-us/eula) on your behalf (`eula=true`). You can
also point the bot at any existing Java server via `MC_HOST`/`MC_PORT`.

## License

[MIT](./LICENSE).
