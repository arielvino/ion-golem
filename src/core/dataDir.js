// dataDir.js — where runtime state lives: a dir per bot, and in it a dir per world.
//
//   <base>/<BotName>/                    per bot: bot.pid, logs/, bot.log, chat-logs/
//   <base>/<BotName>/worlds/<worldKey>/  per world: blocks.db, journal.json, agenda.json, eye-throws.json,
//                                        defend/lead/float/break-mode.json, world.json
//
// The bot dir is known at startup. The world dir only once the server's login packet
// says which world this is, so world memory opens there (bot.js), never before.
const fs = require('fs')
const os = require('os')
const path = require('path')

// Resolution order for the base:
//   1. IONGOLEM_DATA_DIR env override — used verbatim as the base (absolute or relative).
//   2. OS-standard per-user data dir: XDG_DATA_HOME/~/.local/share (Linux), Application
//      Support (macOS), LOCALAPPDATA (Windows), under an `iongolem/` folder.
// Data lives outside the repo by default, so it survives reclones and works from a
// read-only/global install; set IONGOLEM_DATA_DIR=./runtime to keep it local.
function resolveDataBase() {
  const override = process.env.IONGOLEM_DATA_DIR
  if (override) return path.resolve(override)
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'iongolem')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'iongolem')
  }
  const xdg = process.env.XDG_DATA_HOME
  const dataHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share')
  return path.join(dataHome, 'iongolem')
}

// What a bot knew about its one world before per-world dirs, kept in the bot dir itself.
// No longer read: a bot starts each world fresh, and these are left where they are.
const OLD_WORLD_FILES = ['blocks.db', 'journal.json', 'agenda.json', 'eye-throws.json', 'block-memory.json', 'placed-blocks.json',
  'defend-mode.json', 'lead-mode.json', 'float-mode.json', 'break-mode.json']

// The hashed seed from a login/respawn packet (protodef's i64: [hi, lo] or a BigInt) as
// 16 hex digits, or null when the server sent none.
function seedHex(hashedSeed) {
  let v
  if (Array.isArray(hashedSeed)) v = (BigInt(hashedSeed[0] >>> 0) << 32n) | BigInt(hashedSeed[1] >>> 0)
  else if (typeof hashedSeed === 'bigint' || typeof hashedSeed === 'number') v = BigInt(hashedSeed)
  else return null
  return BigInt.asUintN(64, v).toString(16).padStart(16, '0')
}

// A world is the server's address plus the hashed seed it sends on login: one address
// hosts different worlds over time (a regenerated local world, an Aternos server that
// switches worlds) and the seed tells them apart. IONGOLEM_WORLD names the world
// outright instead, for a server whose address changes (an open-to-LAN world picks a new
// port each time). Readable and filesystem-safe: localhost_25565_1a2b3c4d5e6f7a8b.
const safe = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[.-]+|-+$/g, '') || 'unknown'
function worldKey({ host, port, hashedSeed }) {
  if (process.env.IONGOLEM_WORLD) return safe(process.env.IONGOLEM_WORLD)
  const h = ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase()) ? 'localhost' : safe(host)
  return `${h}_${port}_${seedHex(hashedSeed) || 'noseed'}`
}

const worldsDir = (botDir) => path.join(botDir, 'worlds')
const worldDirOf = (botDir, key) => path.join(worldsDir(botDir), key)

// Enter world `key` of bot dir `botDir`: create its dir and keep a world.json saying
// which server and seed it is.
function openWorldDir(botDir, { host, port, hashedSeed, version }) {
  const key = worldKey({ host, port, hashedSeed })
  const dir = worldDirOf(botDir, key)
  fs.mkdirSync(dir, { recursive: true })
  const metaFile = path.join(dir, 'world.json')
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch (e) {}
  const now = new Date().toISOString()
  meta = { ...meta, key, host, port, hashedSeed: seedHex(hashedSeed), version, firstSeen: meta.firstSeen || now, lastSeen: now }
  try { fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2)) } catch (e) { console.warn('  [DATA] world.json write err:', e.message) }
  return { key, dir }
}

// Old-layout world files in the bot dir, if any — reported once at startup.
const oldLayoutFiles = (botDir) => OLD_WORLD_FILES.filter(f => fs.existsSync(path.join(botDir, f)))

module.exports = { resolveDataBase, seedHex, worldKey, worldDirOf, openWorldDir, oldLayoutFiles }
