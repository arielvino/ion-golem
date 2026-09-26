// AI message handling — uses pluggable provider backend (see ai-provider.js)
const fs = require('fs')
const path = require('path')
const state = require('../core/state')
const { getBotContext } = require('./context')
const { applyPlanTags, agendaTitles } = require('../engine/tasks')
const { applyNoteTags, markShown } = require('../world/journalStore')
const { c, color } = require('../lib/colors')
const { sendChat, debugChat, logEvent, isPseudoUsername, resolvePlayerName } = require('../core/utils')
const { createProvider } = require('./ai-provider')
const { logChatDB } = require('../world/memory')
const { parseBlueprint: parseBlueprintRaw } = require('../lib/blueprint')
const { isProvider, providerNames } = require('./ctxProviders')

// --- Chat logging ---
const CHAT_LOG_DIR = () => path.join(state.BOT_DATA_DIR, 'chat-logs')
function getChatLogFile() {
  const d = new Date().toISOString().slice(0, 10)
  return path.join(CHAT_LOG_DIR(), `${d}.jsonl`)
}
function logChat(entry) {
  entry.timestamp = new Date().toISOString()
  try { fs.appendFileSync(getChatLogFile(), JSON.stringify(entry) + '\n') } catch (e) { console.warn('  [AI] chatLog write err:', e.message) }
}
function initChatLogs() {
  try { fs.mkdirSync(CHAT_LOG_DIR(), { recursive: true }) } catch (e) { console.warn('  [AI] chatLog dir err:', e.message) }
}

// --- Chat history ---
const MAX_HISTORY_USERS = 20
function getHistory(u) { if (!state.chatHistory.has(u)) state.chatHistory.set(u, []); return state.chatHistory.get(u) }
function addToHistory(u, role, content) {
  const h = getHistory(u); h.push({ role, content })
  if (state.chatHistory.size > MAX_HISTORY_USERS) {
    const keys = [...state.chatHistory.keys()]
    for (let i = 0; i < keys.length - MAX_HISTORY_USERS; i++) {
      if (keys[i] !== u && keys[i] !== 'self') state.chatHistory.delete(keys[i])
    }
  }
  if (h.length > state.MAX_HISTORY) h.splice(0, h.length - state.MAX_HISTORY)
}

// --- Blueprint parser ---
// Thin wrapper over lib/blueprint's pure parser, preserving the debug logging.
function parseBlueprint(raw) {
  try {
    const result = parseBlueprintRaw(raw)
    if (!result) { console.log('  [BLUEPRINT] no LEGEND line or no blocks parsed'); return null }
    const { blocks, materials, legend } = result
    console.log(`  [BLUEPRINT] legend: ${Object.entries(legend).filter(([k,v]) => v).map(([k,v]) => `${k}=${v}`).join(',')}`)
    console.log(`  [BLUEPRINT] materials: ${Object.entries(materials).map(([k,v]) => `${k}x${v}`).join(', ')}`)
    return { blocks, materials }
  } catch (err) {
    console.log(`  [BLUEPRINT] parse error: ${err.message}`)
    return null
  }
}

// --- SYSTEM PROMPT (with switchable personality) ---
const PERSONALITIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'personalities.json'), 'utf8'))
// The prompt is assembled from scoped files in prompt/ rather than one flat document.
// ORDER is load-bearing, not cosmetic: a capability described 30 lines below a rival
// mechanism loses to it. [CTX:...] originally sat below the MCP tool list and the model
// narrated using it while actually calling inspect_blocks — so views now follow the
// action list directly, where the model is already in "tags I emit" mode.
const PROMPT_ORDER = [
  '00-core.txt',
  '10-tasks.txt',
  '15-memory.txt',
  '20-crafting-mining.txt',
  '30-navigation.txt',
  '40-autonomous.txt',
  '50-actions.txt',
  '55-views.txt',
  '60-building.txt',
  '70-query-tools.txt',
]
const PROMPT_DIR = path.join(__dirname, 'prompt')
const SYSTEM_PROMPT_TEMPLATE = PROMPT_ORDER
  .map(f => fs.readFileSync(path.join(PROMPT_DIR, f), 'utf8').trimEnd())
  .join('\n\n')

function pickRandomPersonality() {
  return PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)]
}

function buildSystemPrompt(personality) {
  return SYSTEM_PROMPT_TEMPLATE.replace('{PERSONALITY}', personality)
}

// Default: debug mode → Claude (fully self-aware of its real architecture), else גבר רצח.
// Keyed off process.argv because ai.js loads before bot.js sets state.debugMode. Use /personality to switch
// (DBG-1, the self-aware debugging instrument, is still in the list as an alternative).
const DBG_PERSONALITY = PERSONALITIES.find(p => p.startsWith('You are playing CLAUDE-the-bot'))
const DEFAULT_PERSONALITY = PERSONALITIES.find(p => p.includes('גבר רצח')) || PERSONALITIES[PERSONALITIES.length - 1]
state.personality = (process.argv.includes('--debug') && DBG_PERSONALITY) ? DBG_PERSONALITY : DEFAULT_PERSONALITY
console.log(`  [PERSONALITY] ${state.personality.slice(0, 60)}...`)
let SYSTEM_PROMPT = buildSystemPrompt(state.personality)

// --- Flatten conversation for single-prompt backends ---
function flattenMessages(msgs) {
  if (msgs.length <= 1) return msgs[0]?.content || ''
  const parts = []
  for (const m of msgs) {
    const label = m.role === 'user' ? 'USER' : 'YOU'
    parts.push(`[${label}] ${m.content}`)
  }
  return parts.join('\n\n')
}

// --- AI Providers ---
// `provider` (Sonnet) makes the decisions; `monitorProvider` (Haiku) handles the
// frequent, mechanical [MONITOR] progress calls — ~3x cheaper and faster. Caches and
// CLI sessions are model-scoped, so a cheaper model needs its own persistent process,
// not a per-call flag on the Sonnet one. See TODO.md "Optimize the AI loop".
const MONITOR_MODEL = 'claude-haiku-4-5'
let provider = null
let monitorProvider = null

// --- Main message handler ---
async function handleMessage(username, message, historyAs) {
  const histKey = historyAs || username
  const isPlayerMessage = username !== 'self' && username !== 'event'
  // Monitor ticks (engine's monitorLoop) are mechanical "still going" checks — route
  // them to the cheaper/faster Haiku provider. Everything else stays on Sonnet.
  const isMonitorCall = username === 'self' && typeof message === 'string' && message.startsWith('[MONITOR]')
  const activeProvider = isMonitorCall ? monitorProvider : provider
  // Autonomous turns have no requesting player, so fall back to the one the
  // current task names. Without it a "follow X" task runs blind — PLAYER= (and
  // its locator fix) is only emitted on turns where X happens to talk to us.
  const playerForContext = isPlayerMessage ? username
    : (historyAs && !isPseudoUsername(historyAs) ? historyAs : resolvePlayerName())
  const context = getBotContext(playerForContext)
  addToHistory(histKey, 'user', `${context}\n${username}: ${message}`)
  logChat({ type: 'user', username, message, context })

  function processTags(rawReply) {
    // [PLAN:op:...] — agenda and goal-tree edits (engine/planOps.js). Ownership
    // follows the speaker: a player's turn acts as that player, anything else as 'self'.
    const planApplied = applyPlanTags(rawReply, isPlayerMessage ? username : 'self')
    if (planApplied.length) console.log(color(c.magenta, `\n  [PLAN] ${planApplied.join('; ')}\n`))

    // [NOTE:...] — the model's running story (world/journal.js).
    const notesApplied = applyNoteTags(rawReply, { allowCompact: !isMonitorCall })
    if (notesApplied.length) console.log(color(c.magenta, `  [NOTE] ${notesApplied.join('; ')}`))
    markShown()

    // [CTX:name] / [CTX:name:arg:arg] — ask for a high-resolution view in the NEXT
    // turn's context. An unknown name is queued rather than dropped: the renderer
    // turns it into a CTX_ERR line listing the real ones, so the model corrects
    // itself from the reply. That feedback loop is the entire validation story.
    for (const m of rawReply.matchAll(/\[CTX:([^\]]+)\]/g)) {
      const parts = m[1].split(':').map(s => s.trim()).filter(Boolean)
      if (parts.length === 0) continue
      const name = parts[0].toLowerCase()
      state.ctxRequests.push({ name, args: parts.slice(1) })
      const bad = isProvider(name) ? '' : color(c.red, ` — UNKNOWN (have: ${providerNames().join(', ')})`)
      console.log(color(c.magenta, `  [CTX] queued ${name}${parts.length > 1 ? ':' + parts.slice(1).join(':') : ''}`) + bad)
    }

    const bpMatch = rawReply.match(/\[BLUEPRINT:([\s\S]*?)\]/)
    if (bpMatch) {
      state.pendingBlueprint = parseBlueprint(bpMatch[1])
      if (state.pendingBlueprint) {
        state.pendingBlueprint.raw = bpMatch[1]
        console.log(`  [BLUEPRINT] parsed: ${state.pendingBlueprint.blocks.length} blocks`)
      }
    }

    return planApplied
  }

  async function streamAndProcess(msgs) {
    // Log model input
    console.log(color(c.cyan, `\n  [MODEL-IN] ${msgs.length} messages:`))
    for (const m of msgs) {
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      // Format context block: one key per line
      const ctxEnd = raw.indexOf(']\n')
      let formatted = raw
      if (raw.startsWith('[pos=') && ctxEnd > 0) {
        const inner = raw.slice(5, ctxEnd)  // skip "[pos=" and trailing "]"
        const rest = raw.slice(ctxEnd + 2)   // after "]\n"
        // Split on top-level keys only (not inside [...] brackets)
        const lines = []
        let cur = '', depth = 0
        for (let i = 0; i < inner.length; i++) {
          const ch = inner[i]
          if (ch === '[') depth++
          else if (ch === ']') depth--
          if (ch === ' ' && depth === 0 && /[A-Z_a-z]/.test(inner[i + 1]) && inner.indexOf('=', i + 1) < inner.indexOf(' ', i + 1)) {
            lines.push(cur)
            cur = ''
            continue
          }
          cur += ch
        }
        if (cur) lines.push(cur)
        // Expand VISION and other dense bracket fields onto sub-lines
        const indented = lines.map(s => {
          const m = s.match(/^(VISION|SOUNDS)=\[(.+)\]$/)
          if (m) {
            const parts = m[2].split(' | ').map(p => `          ${p}`)
            return `        ${m[1]}=[\n${parts.join('\n')}\n        ]`
          }
          return `        ${s}`
        })
        formatted = '      {\n' + indented.join('\n') + '\n      }\n      ' + rest
      }
      const roleColor = m.role === 'user' ? c.cyan : c.gray
      console.log(`    ${color(roleColor, `[${m.role}]`)} ${c.dim}${formatted}${c.reset}\n`)
    }

    const prompt = flattenMessages(msgs)

    // Streaming state — bot-specific logic runs via onDelta callback
    let chatSent = false
    let chatText = ''
    const pendingActions = []

    function onDelta(_delta, fullText) {
      // Early chat send: before first tag
      if (!chatSent) {
        const tagIdx = fullText.search(/\[(?:ACTION|PLAN|NOTE|BLUEPRINT|CTX):?/)
        if (tagIdx > 0) {
          chatText = fullText.substring(0, tagIdx).trim()
          if (chatText && !/^[.\s…]+$/.test(chatText)) {
            sendChat(chatText)  // send early for low latency, log after MODEL-OUT
          }
          chatSent = true
        }
      }

      // Collect actions as they appear
      const newActions = [...fullText.matchAll(/\[ACTION:([^\]]+)\]/g)]
      if (newActions.length > pendingActions.length) {
        for (let i = pendingActions.length; i < newActions.length; i++) {
          pendingActions.push(newActions[i][1])
        }
      }
    }

    function onToolCall(toolName) {
      debugChat(`[query] ${toolName}`)
    }

    const resp = await activeProvider.send(prompt, onDelta, onToolCall)
    const fullText = resp.text

    const inTok = resp.usage?.input_tokens || 0
    const outTok = resp.usage?.output_tokens || 0
    const cachRead = resp.usage?.cache_read_input_tokens || 0
    const cachCreate = resp.usage?.cache_creation_input_tokens || 0
    console.log(color(c.gray, `  [API]${isMonitorCall ? ' [monitor/haiku]' : ''} ${resp.totalMs}ms (first token: ${resp.firstTokenMs}ms, api: ${resp.apiMs}ms) | in=${inTok}tok out=${outTok}tok | cache: read=${cachRead} create=${cachCreate}`))
    console.log(color(c.cyan, `  [MODEL-OUT]`) + ` ${fullText}\n`)

    logChat({ type: 'ai', raw: fullText, stack: [...state.taskStack], agenda: agendaTitles(), messages: msgs })

    const planApplied = processTags(fullText)

    if (!chatSent) {
      chatText = fullText.replace(/\s*\[ACTION:[^\]]+\]/g, '')
        .replace(/\s*\[PLAN:[^\]]+\]/g, '')
        .replace(/\s*\[NOTE:(?:[^[\]]|\[[^[\]]*\])*\]/g, '')
        .replace(/\s*\[CTX:[^\]]+\]/g, '')
        .replace(/\s*\[BLUEPRINT:[\s\S]*?\]/g, '').trim()

      const playerAskedStatus = isPlayerMessage && /agenda|stack|status|what.*doing|task/i.test(message)
      if (!chatText) {
        if (playerAskedStatus || (isPlayerMessage && planApplied.length > 0 && pendingActions.length === 0)) {
          if (state.taskStack.length > 0) {
            chatText = `Agenda: ${agendaTitles()}. Working on: ${state.taskStack.map(e => e.t).join(' → ')}`
          } else {
            chatText = 'Nothing on my agenda!'
          }
        } else if (pendingActions.length > 0) {
          chatText = pendingActions.map(a => a.split(':')[0]).join(', ')
        }
      }
      if (chatText && !/^[.\s…]+$/.test(chatText)) {
        sendChat(chatText)
      }
    }

    // Log bot chat after MODEL-OUT so log reads top-to-bottom
    if (chatText && !/^[.\s…]+$/.test(chatText)) {
      console.log(color(c.blue, `\n[Bot] ${chatText}\n`))
      logChatDB('bot', state.BOT_NAME || 'Bot', chatText)
    }

    // Always record an assistant turn to prevent consecutive user messages
    addToHistory(histKey, 'assistant', chatText || '(working...)')

    // Populate action queue — engine will process it.
    // A `stop` is a PREEMPTION, not a queued action: fire interrupt() synchronously here
    // (the earliest point stop-intent exists) so it bypasses the queue gate that would
    // otherwise schedule it behind the very bg task it's meant to kill. Actions the model
    // queued *after* the stop are kept and run once the killed task settles (interrupt()
    // leaves the task truthfully 'running'; processActionQueue waits for the real settle).
    if (pendingActions.length > 0) {
      state.lastFailures = []
      const stopIdx = pendingActions.findIndex(a => a.split(':')[0] === 'stop')
      if (stopIdx !== -1) {
        console.log(color(c.yellow, `\n  -> stop: preempting current work`))
        require('../engine/engine').interrupt()  // clears queue + sets abortSignal
      }
      const queued = stopIdx === -1 ? pendingActions : pendingActions.slice(stopIdx + 1)
      const actions = queued.map(a => ({ actionStr: a, username: histKey }))
      if (actions.length > 0) {
        console.log(color(c.green, `\n  -> ${actions.length} action(s): ${actions.map(a => a.actionStr).join(' → ')}`))
      }
      state.actionQueue = actions  // assign AFTER interrupt() (which cleared it) = the requeue
    }
  }

  // Log player chat to event history
  if (isPlayerMessage) logEvent(`${username}: "${message}"`)

  try {
    state.lastModelCheck = Date.now()
    // Each request uses a fresh session — no model-side history.
    // HISTORY= provides rolling log of recent actions/events/chat.
    const latestMsg = { role: 'user', content: `${context}\n${username}: ${message}` }
    await streamAndProcess([latestMsg])
    state.apiFailCount = 0
  } catch (err) {
    if (err.message?.includes('abort') || err.message?.includes('SIGTERM')) {
      console.log('  [API] aborted (player interrupted)')
      return
    }
    console.error(color(c.red, `API error: ${err.message}`))
    // Recreate the provider that actually failed (monitor=Haiku vs decision=Sonnet).
    if (isMonitorCall) {
      monitorProvider.destroy()
      monitorProvider = createProvider('claude-code', { model: MONITOR_MODEL })
      monitorProvider.init(SYSTEM_PROMPT)
    } else {
      provider.destroy()
      provider = createProvider()
      provider.init(SYSTEM_PROMPT)
    }
    state.apiFailCount++
    if (state.apiFailCount <= 1) sendChat("Brain lag, try again!")
    if (state.apiFailCount >= 3) {
      console.log(`  [API] backing off after ${state.apiFailCount} failures`)
    }
  }
}

// Abort current in-flight response. Only one call runs at a time (the engine
// awaits each handleMessage), but we don't track which provider is live, so abort
// both — the idle one's abort is a no-op.
function abortResponse() {
  if (provider) provider.abort()
  if (monitorProvider) monitorProvider.abort()
}

// Pre-spawn on load so first message is fast. Two persistent processes: Sonnet for
// decisions, Haiku for the frequent [MONITOR] progress ticks.
function initAI() {
  provider = createProvider()
  provider.init(SYSTEM_PROMPT)
  monitorProvider = createProvider('claude-code', { model: MONITOR_MODEL })
  monitorProvider.init(SYSTEM_PROMPT)
}

// Switch personality at runtime — restarts the AI provider with new system prompt
function switchPersonality(keyword) {
  // Find matching personality by keyword (case-insensitive substring match)
  const kw = keyword.toLowerCase()
  let match = PERSONALITIES.find(p => p.toLowerCase().includes(kw))
  if (!match) {
    // Try matching by index
    const idx = parseInt(keyword, 10)
    if (!isNaN(idx) && idx >= 0 && idx < PERSONALITIES.length) {
      match = PERSONALITIES[idx]
    }
  }
  if (!match) {
    console.log(color(c.yellow, `  [PERSONALITY] no match for "${keyword}", picking random`))
    match = pickRandomPersonality()
  }

  state.personality = match
  SYSTEM_PROMPT = buildSystemPrompt(match)
  console.log(color(c.magenta, `  [PERSONALITY] switched to: ${match.slice(0, 80)}...`))

  // Restart both AI providers with the new system prompt
  if (provider) provider.destroy()
  provider = createProvider()
  provider.init(SYSTEM_PROMPT)
  if (monitorProvider) monitorProvider.destroy()
  monitorProvider = createProvider('claude-code', { model: MONITOR_MODEL })
  monitorProvider.init(SYSTEM_PROMPT)

  return match
}

function getPersonalities() {
  return PERSONALITIES
}

module.exports = { handleMessage, sendChat, initChatLogs, initAI, abortResponse, switchPersonality, getPersonalities }
