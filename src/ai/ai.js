// AI message handling — uses pluggable provider backend (see ai-provider.js)
const fs = require('fs')
const path = require('path')
const state = require('../core/state')
const { getBotContext } = require('./context')
const { applyPlanTags, agendaTitles } = require('../engine/tasks')
const { applyNoteTags, markShown, recordTurn, logWhy, currentNode } = require('../world/journalStore')
const { c, color } = require('../lib/colors')
const { sendChat, debugChat } = require('../core/utils')
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
// mechanism loses to it. [CTX:...] originally sat below a list of MCP query tools and the
// model narrated using it while actually calling inspect_blocks — so views now follow the
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
  '57-past-views.txt',
  '60-building.txt',
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

// --- AI Provider ---
// One persistent Sonnet process answers every turn, [MONITOR] ticks included.
let provider = null

// --- Main message handler ---
async function handleMessage(username, message, historyAs) {
  return handleMessages([{ username, message, historyAs }])
}

// One model turn for everything queued since the last one: a player's lines, game
// events, or both. The turn acts as the last player who spoke (plan ownership,
// action attribution); with no player in the batch, as its first speaker.
async function handleMessages(batch) {
  const isPlayer = (u) => u !== 'self' && u !== 'event'
  const lead = [...batch].reverse().find(m => isPlayer(m.username)) || batch[0]
  const username = lead.username
  const histKey = lead.historyAs || username
  const isPlayerMessage = isPlayer(username)
  const message = batch.filter(m => isPlayer(m.username)).map(m => m.message).join('\n') || lead.message
  const isMonitorCall = batch.length === 1 && username === 'self' && typeof message === 'string' && message.startsWith('[MONITOR]')
  // A player's message becomes its record BEFORE the context is built, so it sits
  // in this turn's NEW= with its own r# and the line below points at it. Recorded
  // after, it showed up unnumbered now and again as a record next turn — and a
  // repeated "come here" read as the old one echoed back.
  const lines = batch.map(m => {
    const said = isPlayer(m.username) ? state.journal?.record(`${m.username}: "${m.message}"`) : null
    return `${said ? `${m.username} just said (${said.id})` : m.username}: ${m.message}`
  })
  const context = getBotContext()
  const input = `${context}\n${lines.join('\n')}`
  addToHistory(histKey, 'user', input)
  for (const m of batch) logChat({ type: 'user', username: m.username, message: m.message, context })

  function processTags(rawReply) {
    // [PLAN:op:...] — agenda and goal-tree edits (engine/planOps.js). Ownership
    // follows the speaker: a player's turn acts as that player, anything else as 'self'.
    const nodeBefore = currentNode()
    const planApplied = applyPlanTags(rawReply, isPlayerMessage ? username : 'self')
    if (planApplied.length) console.log(color(c.magenta, `\n  [PLAN] ${planApplied.join('; ')}\n`))

    // [NOTE:...] — the model's running story (world/journal.js).
    const notesApplied = applyNoteTags(rawReply, nodeBefore)
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
    let dispatched = 0      // pendingActions[0..dispatched) already handed to the engine
    let deferred = false    // hit an action that must wait for the end of the reply
    let queueReplaced = false
    let logsShown = 0

    // Actions run the moment their tag closes, not when the reply ends — a turn that
    // makes a tool call or writes a long NOTE/PLAN after its first action used to sit
    // idle for all of it. The queue semantics are unchanged: a reply's actions REPLACE
    // the queue (on its first action), and a `stop` is a preemption, fired here at the
    // earliest point stop-intent exists so it bypasses the queue gate that would
    // otherwise schedule it behind the very bg task it's meant to kill. Actions after
    // the stop are the requeue: they wait for the killed task's real settle
    // (interrupt() leaves it truthfully 'running'; processActionQueue gates on that).
    function dispatchAction(actionStr) {
      const engine = require('../engine/engine')
      state.actionOpCount++
      if (!queueReplaced) { state.lastFailures = []; state.actionQueue = []; queueReplaced = true }
      if (actionStr.split(':')[0] === 'stop') {
        console.log(color(c.yellow, `\n  -> stop: preempting current work`))
        engine.interrupt({ keepResponse: true })  // clears queue + sets abortSignal
        return
      }
      state.actionQueue.push({ actionStr, username: histKey })
      console.log(color(c.green, `\n  -> action: ${actionStr}`))
      engine.processActionQueue()
    }

    // `build` reads the [BLUEPRINT] and the focused goal, which are applied only once
    // the whole reply is in (processTags) — it and everything after it wait for that.
    const DEFER_TO_END = new Set(['build'])
    function dispatchReady(final) {
      for (; dispatched < pendingActions.length; dispatched++) {
        const a = pendingActions[dispatched]
        if (!final && (deferred || DEFER_TO_END.has(a.split(':')[0]))) { deferred = true; return }
        dispatchAction(a)
      }
    }

    function onDelta(_delta, fullText) {
      // Early chat send: before first tag
      if (!chatSent) {
        const tagIdx = fullText.search(/\[(?:ACTION|PLAN|NOTE|BLUEPRINT|CTX|LOG):?/)
        if (tagIdx > 0) {
          chatText = fullText.substring(0, tagIdx).trim()
          if (chatText && !/^[.\s…]+$/.test(chatText)) {
            sendChat(chatText)  // send early for low latency, log after MODEL-OUT
          }
          chatSent = true
        }
      }

      // [LOG:...] — the model's one-line "why", printed as soon as it closes so the
      // console shows the reasoning next to the action it explains.
      const logs = [...fullText.matchAll(/\[LOG:([^\]]+)\]/g)]
      for (; logsShown < logs.length; logsShown++) {
        console.log(color(c.yellow, `  [LOG] ${logs[logsShown][1].trim()}`))
      }

      // Collect actions as they appear, and start each one right away
      const newActions = [...fullText.matchAll(/\[ACTION:([^\]]+)\]/g)]
      if (newActions.length > pendingActions.length) {
        for (let i = pendingActions.length; i < newActions.length; i++) {
          pendingActions.push(newActions[i][1])
        }
        dispatchReady(false)
      }
    }

    function onToolCall(toolName) {
      debugChat(`[query] ${toolName}`)
    }

    const resp = await provider.send(prompt, onDelta, onToolCall)
    const fullText = resp.text

    const inTok = resp.usage?.input_tokens || 0
    const outTok = resp.usage?.output_tokens || 0
    const cachRead = resp.usage?.cache_read_input_tokens || 0
    const cachCreate = resp.usage?.cache_creation_input_tokens || 0
    console.log(color(c.gray, `  [API]${isMonitorCall ? ' [monitor]' : ''} ${resp.totalMs}ms (first token: ${resp.firstTokenMs}ms, api: ${resp.apiMs}ms) | in=${inTok}tok out=${outTok}tok | cache: read=${cachRead} create=${cachCreate}`))
    console.log(color(c.cyan, `  [MODEL-OUT]`) + ` ${fullText}\n`)

    logChat({ type: 'ai', raw: fullText, stack: [...state.taskStack], agenda: agendaTitles(), messages: msgs })

    const planApplied = processTags(fullText)

    if (!chatSent) {
      chatText = fullText.replace(/\s*\[ACTION:[^\]]+\]/g, '')
        .replace(/\s*\[LOG:[^\]]+\]/g, '')
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

    // Whatever the stream held back (a deferred `build` and its followers) runs now
    // that processTags has applied the blueprint and plan edits.
    const streamed = dispatched
    dispatchReady(true)
    if (pendingActions.length > 0) {
      console.log(color(c.green, `\n  -> ${pendingActions.length} action(s): ${pendingActions.join(' → ')}${streamed ? ` (${streamed} started mid-reply)` : ''}`))
    }

    recordTurn({
      said: chatText && !/^[.\s…]+$/.test(chatText) ? chatText : '',
      actions: pendingActions,
      views: [...fullText.matchAll(/\[CTX:([^\]]+)\]/g)].map(m => m[1].trim()),
      why: logWhy(fullText),
    })
  }

  try {
    state.lastModelCheck = Date.now()
    // Each request uses a fresh session — no model-side history.
    // NOTES and NEW= (the journal) carry memory across requests.
    const latestMsg = { role: 'user', content: input }
    await streamAndProcess([latestMsg])
    state.apiFailCount = 0
  } catch (err) {
    if (err.message?.includes('abort') || err.message?.includes('SIGTERM')) {
      console.log('  [API] aborted (player interrupted)')
      return
    }
    console.error(color(c.red, `API error: ${err.message}`))
    provider.destroy()
    provider = createProvider()
    provider.init(SYSTEM_PROMPT)
    state.apiFailCount++
    if (state.apiFailCount <= 1) sendChat("Brain lag, try again!")
    if (state.apiFailCount >= 3) {
      console.log(`  [API] backing off after ${state.apiFailCount} failures`)
    }
  }
}

// Abort the current in-flight response.
function abortResponse() {
  if (provider) provider.abort()
}

// Pre-spawn on load so the first message is fast.
function initAI() {
  provider = createProvider()
  provider.init(SYSTEM_PROMPT)
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

  // Restart the AI provider with the new system prompt
  if (provider) provider.destroy()
  provider = createProvider()
  provider.init(SYSTEM_PROMPT)

  return match
}

function getPersonalities() {
  return PERSONALITIES
}

module.exports = { handleMessage, handleMessages, sendChat, initChatLogs, initAI, abortResponse, switchPersonality, getPersonalities }
