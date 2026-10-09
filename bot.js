// Entry point — PID, createBot, shutdown, signals
require('./src/lib/physicsEpsilonFix')   // before mineflayer's physics: vanilla collision tolerance
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
const toolPlugin = require('mineflayer-tool').plugin
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const state = require('./src/core/state')
const { c, color } = require('./src/lib/colors')
const { initDB } = require('./src/world/memory')
const { loadAgenda, agendaTitles } = require('./src/engine/tasks')
const { updateBlockMemoryReach, clearOldPathBlocks, updateChunkBiomes, logChatDB, logGameEvent, upsertVisionChunked } = require('./src/world/memory')
const { initChatLogs, initAI } = require('./src/ai/ai')
const { setupAutonomous } = require('./src/engine/autonomous')
const { startEngine, stopEngine, interrupt, softInterrupt } = require('./src/engine/engine')
const { castVisionRays } = require('./src/perception/vision')
const { surveyVisible } = require('./src/perception/visibility')
const ranges = require('./src/config/ranges')
const { stopAll } = require('./src/core/tick')

// --- Bot config ---
const DEBUG_MODE = process.argv.includes('--debug')
// --no-ai: start with model calls paused (a debugging bot driven by !act); `!ai on` resumes.
if (process.argv.includes('--no-ai')) state.aiPaused = true
// --no-chat: never speak in game (a quiet test bot); what it would say is printed instead.
if (process.argv.includes('--no-chat')) state.chatMuted = true
const nameArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
const BOT_NAME = nameArg || process.env.MC_USERNAME || (DEBUG_MODE ? 'BroDev' : 'Bro')
state.debugMode = DEBUG_MODE

// Connection target — defaults to a local offline server on localhost:25565.
// Override via env for a remote/online server (e.g. MC_HOST=play.example.net MC_PORT=25565).
const BOT_HOST = process.env.MC_HOST || 'localhost'
const BOT_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const BOT_VERSION = process.env.MC_VERSION || '26.3'
const BOT_OPTIONS = { host: BOT_HOST, port: BOT_PORT, username: BOT_NAME, version: BOT_VERSION }
// Auth mode ('offline' | 'microsoft'). Only set when provided, so default local offline play is unchanged.
if (process.env.MC_AUTH) BOT_OPTIONS.auth = process.env.MC_AUTH

// When targeting a remote host through an HTTP proxy (e.g. restricted egress), tunnel via CONNECT.
const isLocalHost = BOT_HOST === 'localhost' || BOT_HOST === '127.0.0.1'
const PROXY_URL = process.env.http_proxy || process.env.HTTP_PROXY
if (!isLocalHost && PROXY_URL) {
  const proxyUrl = new URL(PROXY_URL)
  BOT_OPTIONS.connect = (client) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port,
      method: 'CONNECT',
      path: `${BOT_HOST}:${BOT_PORT}`,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        client.emit('error', new Error(`Proxy CONNECT failed: ${res.statusCode}`))
        return
      }
      console.log(`  [PROXY] tunnel established to ${BOT_HOST}:${BOT_PORT}`)
      client.setSocket(socket)
      client.emit('connect')
    })
    req.on('error', (err) => client.emit('error', err))
    req.end()
  }
}
state.BOT_NAME = BOT_NAME

// --- Runtime data directory (all per-bot generated state lives here) ---
// Resolution order:
//   1. IONGOLEM_DATA_DIR env override — used verbatim as the base (absolute or relative).
//   2. OS-standard per-user data dir: XDG_DATA_HOME/~/.local/share (Linux), Application
//      Support (macOS), LOCALAPPDATA (Windows), under an `iongolem/` folder.
// A per-bot subdirectory (BOT_NAME) is created under the resolved base, so multiple bots
// keep separate state. Data lives outside the repo by default, so it survives reclones and
// works from a read-only/global install; set IONGOLEM_DATA_DIR=./runtime to keep it local.
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
const RUNTIME_DIR = path.join(resolveDataBase(), BOT_NAME)
state.BOT_DATA_DIR = RUNTIME_DIR
fs.mkdirSync(RUNTIME_DIR, { recursive: true })
console.log(`  [DATA] runtime dir: ${RUNTIME_DIR}`)

// --- Rotating log files ---
const LOG_DIR = path.join(RUNTIME_DIR, 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const logFile = path.join(LOG_DIR, `bot-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
const logStream = fs.createWriteStream(logFile, { flags: 'a' })
const latestLog = path.join(RUNTIME_DIR, 'bot.log')
try { fs.unlinkSync(latestLog) } catch(e) {}
try { fs.symlinkSync(logFile, latestLog) } catch(e) {}
// Timestamp every log-file line with local HH:MM:SS.mmm (matches the server log's clock),
// so slow turns and stalls can be timed from the log alone.
let atLineStart = true
const stamp = (s) => {
  if (typeof s !== 'string') return s
  const d = new Date()
  const t = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')} `
  let out = ''
  for (const part of s.split(/(?<=\n)/)) { out += (atLineStart ? t : '') + part; atLineStart = part.endsWith('\n') }
  return out
}
const origStdoutWrite = process.stdout.write.bind(process.stdout)
const origStderrWrite = process.stderr.write.bind(process.stderr)
const stripAnsi = (s) => typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m/g, '') : s
// Debug filter: in non-debug mode, only show important lines (Bot chat, join, errors) on stdout.
// Everything always goes to the log file.
const SHOW_RE = /\[Bot\]|Bot has joined|Shutting down|ERROR|FATAL|unhandledRejection/
process.stdout.write = (chunk, ...args) => {
  logStream.write(stamp(stripAnsi(chunk)))
  if (!DEBUG_MODE && typeof chunk === 'string') {
    const plain = stripAnsi(chunk)
    if (plain.trim().length > 0 && !SHOW_RE.test(plain)) return true
  }
  return origStdoutWrite(chunk, ...args)
}
process.stderr.write = (chunk, ...args) => {
  logStream.write(stamp(stripAnsi(chunk)))
  if (!DEBUG_MODE && typeof chunk === 'string') {
    const plain = stripAnsi(chunk)
    if (plain.trim().length > 0 && !SHOW_RE.test(plain)) return true
  }
  return origStderrWrite(chunk, ...args)
}
try {
  const logs = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('bot-')).sort().reverse()
  for (const old of logs.slice(5)) fs.unlinkSync(path.join(LOG_DIR, old))
} catch(e) { console.warn('  [BOT] log rotation err:', e.message) }

// --- PID file ---
const PID_FILE = path.join(RUNTIME_DIR, 'bot.pid')
try {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0)
      console.error(`Another bot instance is already running (PID ${oldPid}). Exiting.`)
      process.exit(1)
    } catch (e) { /* stale PID */ }
  }
} catch (e) {}
fs.writeFileSync(PID_FILE, String(process.pid))

// Init database + chat logs + pre-spawn claude
initDB()
initChatLogs()
initAI()

// --- Reconnection ---
let shuttingDown = false
let reconnectTimer = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5

// --- Bot setup ---
function createBot() {
  const bot = mineflayer.createBot(BOT_OPTIONS)
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvp)
  bot.loadPlugin(toolPlugin)
  state.bot = bot

  // Fix mineflayer/minecraft-data version mismatch: entity_velocity packet
  // uses vec3i16 (packet.velocity.x/y/z) but feature flag says to use
  // packet.velocityX/Y/Z (which is undefined → NaN → position corruption).
  // Patch: sanitize velocity after any entity_velocity packet for the bot.
  bot.once('inject_allowed', () => {
    const { Vec3 } = require('vec3')
    bot._client.prependListener('entity_velocity', (packet) => {
      if (packet.entityId === bot.entity?.id && packet.velocity) {
        // Ensure velocity fields are accessible as flat properties for legacy code path
        if (packet.velocityX === undefined) {
          packet.velocityX = packet.velocity.x
          packet.velocityY = packet.velocity.y
          packet.velocityZ = packet.velocity.z
        }
      }
    })

    // Difficulty: on 1.21.x the protocol already maps the difficulty packet's varint
    // to its name ("peaceful"), and mineflayer's game.js then indexes its own name
    // array with that string → bot.game.difficulty is always undefined. Runs after
    // mineflayer's handler, so this assignment wins. (Upstream bug in game.js.)
    bot._client.on('difficulty', (packet) => {
      if (typeof packet.difficulty === 'string') bot.game.difficulty = packet.difficulty
    })

    // Locator Bar (MC 1.21.6+): the server pushes tracked_waypoint for other
    // players even when they're out of render range. It carries either an exact
    // position (vec3i), a rough chunk position (chunk), or — for very distant
    // players — just a world-frame bearing (azimuth). This is the same signal a
    // human player reads off the locator bar to know which way to head. Keyed by
    // player UUID; context.js turns it into a heading + rough distance.
    // The server sends a waypoint only when it changes (the player crosses into a new
    // block / chunk / bearing) and removes it with 'untrack' — a player standing still
    // gets no packets at all, so an entry stays valid until untracked, never timed out.
    bot._waypoints = new Map()
    bot.on('playerLeft', (p) => { if (p?.uuid) bot._waypoints.delete(p.uuid) })
    bot._client.on('tracked_waypoint', (packet) => {
      try {
        const wp = packet.waypoint
        if (!wp) return
        const key = wp.uuid || wp.id
        if (!key) return
        if (packet.operation === 'untrack') { bot._waypoints.delete(key); return }
        const entry = { type: wp.type, t: Date.now() }
        if (wp.type === 'vec3i' && wp.data) {
          entry.x = wp.data.x; entry.y = wp.data.y; entry.z = wp.data.z
        } else if (wp.type === 'chunk' && wp.data) {
          entry.chunkX = wp.data.chunkX; entry.chunkZ = wp.data.chunkZ
        } else if (wp.type === 'azimuth') {
          entry.azimuth = wp.data
        }
        bot._waypoints.set(key, entry)
      } catch (e) { /* malformed waypoint packet — ignore */ }
    })
  })

  bot.once('spawn', () => {
    reconnectAttempts = 0
    state.joinedAt = Date.now()
    console.log('Bot has joined')

    // --- Sound registry off-by-one fix ---
    // minecraft-data's pc/<ver>/sounds.json is 1-indexed (id 0 missing) for 1.21.1+
    // (regression; 1.20.4 was 0-indexed), but the wire protocol's sound_effect soundId
    // is 0-indexed. mineflayer resolves names via bot.registry.sounds[soundId]
    // (sound.js), so every heard sound is mislabeled as the NEXT sound in registry
    // order — e.g. entity.player.hurt (1251) read as entity.player.death → "Player dies"
    // → the AI narrates deaths that never happened. Verified against the server's own
    // --reports dump: server[N].name === minecraft_data[N+1].name for all ids.
    // Shift the registry down by one so mineflayer's own resolution becomes correct.
    // Idempotent: prismarine-registry caches the registry object across reconnects, so
    // the sounds[0]===undefined guard prevents a double shift. (Upstream bug: report to
    // PrismarineJS/minecraft-data.)
    const snd = bot.registry?.sounds
    if (snd && snd[0] === undefined && snd[1] !== undefined) {
      const fixed = {}
      for (const k of Object.keys(snd)) {
        const id = Number(k) - 1
        fixed[id] = { ...snd[k], id }
      }
      bot.registry.sounds = fixed
      console.log(`  [SOUND] corrected off-by-one sound registry (${Object.keys(fixed).length} ids, now 0-indexed)`)
    }

    require('./src/world/memory').checkStateVersion(bot.version)

    const mcData = require('minecraft-data')(bot.version)
    const mv = new Movements(bot, mcData)
    mv.allowSprinting = true
    mv.canOpenDoors = true
    mv.canDig = false
    // No scaffolding: pathfinder never picks its pillar/bridge blocks back up, so it
    // left stray dirt and cobble all over. Pillaring and bridging are explicit actions.
    mv.allow1by1towers = false
    mv.allowParkour = true
    mv.maxDropDown = 4
    mv.scafoldingBlocks = []
    bot.pathfinder.setMovements(mv)
    if (process.argv.includes('--cardinal')) console.log(color(c.yellow, '[NAV] walk/pathfind use cardinalWalk (--cardinal)'))

    loadAgenda()
    require('./src/world/journalStore').loadJournal()
    clearOldPathBlocks()
    // Vision + DB updates run in small async batches to avoid blocking the event loop.
    // Blocking causes physics freezes visible as teleporting/floating every 2s.
    // Vision: reduced resolution (8 vs 16) to cut blockAt calls ~4x.
    // Interval 3s. DB upserts chunked async to avoid event loop blocking.
    let visionBusy = false
    const visionInterval = setInterval(async () => {
      if (!bot?.entity || visionBusy) return
      visionBusy = true
      try {
        const result = castVisionRays(8, ranges.sight.rayScanBlocks)
        if (result) {
          await upsertVisionChunked(result)
          updateChunkBiomes(result)
        }
        // Refresh the find+LOS survey that now feeds the context's see= (FOV cone).
        // Affordances (open/gaps) still come from the ray result above.
        try {
          const t0 = Date.now()
          const sv = surveyVisible({ maxDistance: ranges.sight.ambientSurveyBlocks, fovDegrees: ranges.sight.ambientFovDegrees, cap: ranges.sight.ambientSurveyCap, visibleCap: ranges.sight.ambientVisibleCap })
          const dt = Date.now() - t0
          if (dt > 120) console.log(`  [VIEW] slow survey ${dt}ms (${sv?.visibleCount} vis / ${sv?.losTests} los / ${sv?.candidatesScanned} scan, r${sv?.maxDistance})`)
        } catch (e) { console.warn('  [VIEW] survey err:', e.message) }
      } catch (e) { console.warn('  [VISION] periodic scan err:', e.message) }
      visionBusy = false
    }, 3000)
    // Nearby blocks updated via vision system only — no direct bot.blockAt (x-ray rule)

    // Log item pickups. Journal records are batched: a kill's drops land within a
    // second or two, and become one "pickup:" record instead of one per stack.
    const pickupBatch = new Map()
    let pickupFlush = null
    const journalPickup = (name, count) => {
      pickupBatch.set(name, (pickupBatch.get(name) || 0) + count)
      if (pickupFlush) return
      pickupFlush = setTimeout(() => {
        pickupFlush = null
        const { logEvent } = require('./src/core/utils')
        logEvent(`pickup: ${[...pickupBatch].map(([n, c]) => `${c} ${n}`).join(', ')}`)
        pickupBatch.clear()
      }, 2000)
    }
    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity) return
      if (collected.name === 'experience_orb') return  // its metadata slot 8 is the xp value, not an item
      try {
        const pos = collected.position
        const md = collected.metadata
        let name = null, count = 1
        // A stuck arrow or a returning trident is picked up as itself, not an item stack.
        if (['arrow', 'spectral_arrow', 'trident'].includes(collected.name)) name = collected.name

        // metadata is object keyed by index. Key 8 = "item" (item_stack) for item entities.
        // The value is the raw protocol item_stack: { itemId, itemCount, ... }
        // or on some versions: { present, itemId, itemCount }
        if (md && !name) {
          // Try key 8 first (standard item entity metadata slot)
          const itemData = md[8]
          if (itemData && typeof itemData === 'object') {
            if (itemData.itemId != null) {
              name = mcData.items[itemData.itemId]?.name
              count = itemData.itemCount || 1
            } else if (itemData.value?.itemId != null) {
              name = mcData.items[itemData.value.itemId]?.name
              count = itemData.value.itemCount || 1
            }
          }
          // Fallback: scan all metadata values for anything with itemId
          if (!name) {
            for (const key of Object.keys(md)) {
              const v = md[key]
              if (v && typeof v === 'object' && v.itemId != null) {
                name = mcData.items[v.itemId]?.name
                count = v.itemCount || 1
                break
              }
            }
          }
        }

        if (name) {
          const { debugChat } = require('./src/core/utils')
          debugChat(`[pickup] ${count}x ${name}`)
          logGameEvent('pickup', name, count, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
          journalPickup(name, count)
        } else {
          console.log(`  [PICKUP] could not resolve item. md[8]=${JSON.stringify(md?.[8])?.slice(0,100)}`)
        }
      } catch (e) { console.log(`  [PICKUP] err: ${e.message}`) }
    })

    bot.once('end', () => { clearInterval(visionInterval) })

    setupAutonomous(interrupt)
    require('./src/perception/playerSignals').bind(bot)
    require('./src/perception/effects').bind(bot)
    require('./src/perception/environment').bind(bot)
    require('./src/perception/selfStatus').bind(bot)

    // --- Accessibility subtitles from sound events ---
    const langData = (() => {
      try {
        return require(`minecraft-data`)(bot.version).language
          || require(`./node_modules/minecraft-data/minecraft-data/data/pc/${bot.version}/language.json`)
      } catch(e) { return {} }
    })()
    const SUBTITLE_MAX = 15
    const SUBTITLE_TTL = 8000  // 8 seconds
    const SUBTITLE_CATEGORIES = { 4: 'block', 5: 'hostile', 6: 'neutral', 7: 'player', 8: 'ambient' }
    // Filter out spammy/useless sounds
    const SUBTITLE_IGNORE = new Set([
      'subtitles.block.generic.footsteps', 'subtitles.entity.generic.splash',
      'subtitles.block.generic.break', 'subtitles.block.generic.place',
      'subtitles.block.generic.hit', 'subtitles.entity.generic.swim',
      'subtitles.entity.player.attack.weak',
    ])

    bot.on('soundEffectHeard', (soundName, position, volume, pitch) => {
      // Convert sound name to subtitle key: minecraft:entity.zombie.ambient → subtitles.entity.zombie.ambient
      const stripped = soundName.replace(/^minecraft:/, '')
      const subtitleKey = `subtitles.${stripped}`
      const text = langData[subtitleKey]
      if (!text || SUBTITLE_IGNORE.has(subtitleKey)) return
      const dist = Math.round(bot.entity.position.distanceTo(position))
      if (dist > ranges.hearing.soundSubtitles) return  // too far to care
      // Deduplicate: don't add if same text within last 2s
      const now = Date.now()
      const isDupe = state.recentSubtitles.some(s => s.text === text && now - s.ts < 2000)
      if (isDupe) return
      state.recentSubtitles.push({
        text, x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z),
        dist, ts: now,
      })
      // Trim old entries
      state.recentSubtitles = state.recentSubtitles
        .filter(s => now - s.ts < SUBTITLE_TTL)
        .slice(-SUBTITLE_MAX)
    })

    // Start the engine loop (idempotent — won't start twice)
    startEngine()

    // Say something on join
    logChatDB('event', bot.username, `${bot.username} joined the game`)
    state.messageQueue.push({
      username: 'event',
      message: `[GAME EVENT] [BOOT] You (${bot.username}) just started up and joined the server.`
    })

    if (state.agenda.entries.length > 0) {
      console.log(`  [LOOP] resuming agenda: ${agendaTitles()}`)
    }
  })

  let noPathCount = 0
  bot.on('path_update', r => {
    if (r.status === 'noPath') {
      noPathCount++
      if (noPathCount <= 2 || noPathCount % 10 === 0) console.log(`  no path! (x${noPathCount})`)
    } else { noPathCount = 0 }
  })

  // A whisper (/msg) is a player talking to the bot like chat; mineflayer emits it as
  // 'whisper' ("X whispers to you: …" isn't chat's <X> form), so it takes the same path.
  const onChat = (username, message) => {
    if (username === bot.username) return
    if (username.startsWith('Bot') && username !== bot.username) {
      console.log(`<${username}> ${message}  [ignored: other bot]`)
      return
    }
    console.log(color(c.bold + c.white, `\n<${username}> ${message}`))
    // !nobreak / !defend / !float / !lead on|off are for the bot, not the AI; a yes/no to a pending break request is
    // recorded here and still reaches the AI below.
    if (require('./src/engine/breakPermission').onPlayerChat(username, message)) return
    if (require('./src/engine/defendMode').onPlayerChat(username, message)) return
    if (require('./src/engine/floatMode').onPlayerChat(username, message)) return
    if (require('./src/engine/leadMode').onPlayerChat(username, message)) return
    // Debug-only repro hooks: `!act <action>` runs an action with no model in the loop,
    // `!ai off|on` pauses/resumes model calls so the AI can't steer a staged scenario.
    // Pair with server-console setblock/fill/tp to reproduce a bug deterministically.
    if (state.debugMode && message.startsWith('!ai ')) { state.aiPaused = message.slice(4).trim() === 'off'; console.log(`  [DEBUG] aiPaused=${state.aiPaused}`); return }
    if (state.debugMode && message.startsWith('!act ')) {
      state.actionQueue.push({ actionStr: message.slice(5).trim(), username })
      require('./src/engine/engine').processActionQueue()
      return
    }
    // With model calls paused nothing would answer, so say so from code. The message is still
    // queued below and reaches the AI once it is back on.
    if (state.aiPaused) require('./src/core/utils').sendChat(`[ai] AI is off, so I can't answer right now.${state.debugMode ? ' "!ai on" turns it back on.' : ''}`)
    logChatDB('chat', username, message)
    state.noActionRounds = 0
    // Soft interrupt: abort self-loop AI call (if running) to free the provider,
    // zero the timer so engine processes this message immediately.
    // Don't abort if already handling a player message (msgPending).
    if (!state.msgPending) softInterrupt()
    state.messageQueue.push({ username, message })
  }
  bot.on('chat', onChat)
  bot.on('whisper', onChat)

  // System/game events
  bot.on('messagestr', (message, messagePosition) => {
    if (messagePosition !== 'system' && messagePosition !== 'game_info') return
    const msg = message.toString().trim()
    if (!msg) return
    const patterns = [
      /^(\w+) joined the game$/,
      /^(\w+) left the game$/,
      /^(\w+) (was |died|drowned|burned|fell|hit the ground|went up in flames|walked into|tried to swim|suffocated|starved|was blown|was killed|was slain|was shot|was pummeled|was squished|withered|experienced)/,
      /^(\w+) has made the advancement/,
      /^(\w+) has completed the challenge/,
      /^(\w+) has reached the goal/,
    ]
    const isGameEvent = patterns.some(p => p.test(msg))
    if (!isGameEvent) return
    const eventPlayer = msg.match(/^(\w+)/)?.[1]
    const isBotEvent = msg.startsWith(bot.username + ' ')
    // Always log bot's own events to chat_log DB. Most aren't queued as AI messages (noise),
    // but the bot's own DEATH is a first-class event: queue it so the model wakes to react to
    // dying + respawning — otherwise (esp. with idle skip) it could respawn and sit silent.
    if (isBotEvent) {
      logChatDB('event', bot.username, msg)
      // Own advancement: a journal record, so the model sees the milestone in NEW=.
      const adv = msg.match(/has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]/)
      if (adv) require('./src/core/utils').logEvent(`advancement: ${adv[1]}`)
      // Log bot death as game event with cause
      if (/was |died|drowned|burned|fell|hit the ground|went up in flames|walked into|tried to swim|suffocated|starved|was blown|was killed|was slain|was shot/.test(msg)) {
        const pos = bot.entity?.position
        const cause = msg.replace(bot.username + ' ', '')
        logGameEvent('death', cause, 1, pos ? Math.floor(pos.x) : null, pos ? Math.floor(pos.y) : null, pos ? Math.floor(pos.z) : null, { message: msg })
        require('./src/core/utils').logEvent(`death: ${cause}${pos ? ` at ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : ''}`)
        state.diedAt = Date.now()
        if (!state.msgPending) softInterrupt()  // like chat: react now, not next tick
        state.messageQueue.push({
          username: 'event',
          message: `[GAME EVENT] You (${bot.username}) ${cause}. You have died and respawned — check your position and inventory.`
        })
      }
      return
    }
    if (eventPlayer && eventPlayer.startsWith('Bot') && eventPlayer !== bot.username) {
      console.log(`  [EVENT] ${msg}  [ignored: other bot]`)
      return
    }
    console.log(color(c.yellow, `\n  [EVENT] ${msg}`))
    logChatDB('event', eventPlayer || null, msg)
    if (!state.msgPending) softInterrupt()  // like chat: react now, not next tick
    state.messageQueue.push({
      username: 'event',
      message: `[GAME EVENT] ${msg}`
    })
  })

  bot.on('kicked', r => {
    console.log('Kicked:', r)
    stopAll()
    state.currentTask = null
    state.actionQueue = []
    state.backgroundTask = null
    state.messageQueue = []
    state.portableCraftingTable = null
  })

  bot.on('error', e => console.error(color(c.red, `Error: ${e.message}`)))

  bot.on('death', () => {
    state.portableCraftingTable = null
    state.diedAt = Date.now()
    // Death reason logged via messagestr handler with full message (e.g. "Bro was slain by Zombie")
  })

  // Crossing into another dimension: coordinates from the old one mean nothing
  // here, so drop transient position state. Block memory is keyed by dimension.
  bot.on('spawn', () => {
    const dim = require('./src/world/memory').currentDim()
    if (state.dim && state.dim !== dim) {
      state.skipBlocks.clear()
      state.portableCraftingTable = null
      state.doorToRestore = null
      state.prevSnapshot = null
      const p = bot.entity.position
      require('./src/core/utils').logEvent(`dimension: ${state.dim} → ${dim}, at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    }
    state.dim = dim
  })

  // After a death, record where the bot came back and what it still carries.
  bot.on('spawn', () => {
    if (!state.diedAt) return
    state.diedAt = null
    const p = bot.entity.position
    const items = bot.inventory.items()
    require('./src/core/utils').logEvent(`respawn: at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}, inventory ${items.length ? items.map(i => `${i.count} ${i.name}`).join(', ') : 'empty'}`)
  })

  bot.on('end', () => {
    require('./src/core/utils').clearChatQueue()
    if (shuttingDown) return
    stopEngine()
    reconnectAttempts++
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.log(`Disconnected. Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up.`)
      shutdown('max-reconnects')
      return
    }
    const delay = Math.min(5000 * reconnectAttempts, 30000)
    console.log(`Disconnected, reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
    stopAll()
    state.currentTask = null
    state.actionQueue = []
    state.backgroundTask = null
    state.messageQueue = []
    state.portableCraftingTable = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(createBot, delay)
  })
}

// --- Graceful shutdown ---
function shutdown(signal) {
  if (shuttingDown) { process.exit(0); return }
  shuttingDown = true
  console.log(`Shutting down (${signal})...`)
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  stopEngine()
  stopAll()
  try { state.bot?.quit() } catch (e) {}
  try { state.db?.close() } catch (e) {}
  try { fs.unlinkSync(PID_FILE) } catch (e) {}
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err)
})

createBot()
