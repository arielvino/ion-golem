// Pluggable AI backend abstraction
//
// Provider interface:
//   init(systemPrompt)                    — start/warm up the backend
//   send(prompt, onDelta) → Promise<{     — send prompt, stream via onDelta(delta, fullText)
//     text, usage, firstTokenMs, apiMs, totalMs }>
//   abort()                               — abort current in-flight request
//   destroy()                             — tear down backend resources
//
// usage shape: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
//
// To add a new backend: implement the 4 methods and register in PROVIDERS below.

const { spawn } = require('child_process')
const path = require('path')
const state = require('./state')
const { c, color } = require('./lib/colors')

// ——— Claude Code CLI provider (claude -p with stream-json) ———

function createClaudeCodeProvider(opts = {}) {
  const model = opts.model || process.env.AI_MODEL || 'sonnet'
  let proc = null
  let ready = false
  let responseResolve = null
  let buffer = ''
  let current = null  // { start, firstTokenMs, text, usage, apiMs, onDelta, gen }
  let pendingAborts = 0  // # of aborted requests whose terminal `result` we must still drain
  let systemPrompt = ''
  let sessionCounter = 0

  function handleLine(line) {
    let event
    try { event = JSON.parse(line) } catch (e) { return }

    // Init event — process is ready
    if (event.type === 'system' && event.subtype === 'init') {
      ready = true
      console.log(color(c.gray, `  [AI] persistent process ready (${model})`))
      return
    }

    // Drain stale output from aborted requests FIRST — before the `!current` guard,
    // because abort() nulls `current`. The CLI can't be stopped mid-request, so it keeps
    // generating and emits exactly one terminal `result` per request, in stdout order.
    // Skip every event until we've consumed one `result` per pending abort; otherwise a
    // stale `result` gets matched to the next request (garbage usage/timing) or, worse, the
    // drain swallows the next request's own result so it never resolves → the 90s timeout
    // that surfaced in chat as "Brain lag". See abort().
    if (pendingAborts > 0) {
      if (event.type === 'result') pendingAborts--
      return
    }

    if (!current) return

    // Streaming text deltas
    if (event.type === 'stream_event' && event.event) {
      const ev = event.event
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (!current.firstTokenMs) current.firstTokenMs = Date.now() - current.start
        current.text += ev.delta.text
        if (current.onDelta) current.onDelta(ev.delta.text, current.text)
      }
      // Detect MCP tool calls — announce in chat
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        const toolName = ev.content_block.name || ''
        // Strip mcp__bot-query__ prefix for readability
        const short = toolName.replace(/^mcp__bot-query__/, '')
        if (short) {
          console.log(color(c.gray, `  [AI] tool call: ${short}`))
          if (current.onToolCall) current.onToolCall(short)
        }
      }
    }

    // Non-streaming fallback: full assistant message
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) current.text = block.text
      }
    }

    // Final result
    if (event.type === 'result') {
      if (event.result && !current.text) current.text = event.result
      current.usage = event.usage || null
      current.apiMs = event.duration_api_ms || 0
      if (responseResolve) {
        const r = responseResolve
        responseResolve = null
        r.resolve(current)
      }
    }
  }

  function spawnProc() {
    if (proc) return
    const env = { ...process.env }
    delete env.CLAUDECODE

    // MCP config for bot query tools
    const dbPath = state.BOT_DATA_DIR ? path.join(state.BOT_DATA_DIR, 'blocks.db') : null
    const mcpServerPath = path.join(__dirname, 'mcp-server.js')
    const mcpConfig = dbPath ? JSON.stringify({
      mcpServers: {
        'bot-query': {
          command: 'node',
          args: [mcpServerPath],
          env: { BOT_DB_PATH: dbPath },
        },
      },
    }) : null

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--tools', 'WebSearch,WebFetch',
      '--allowedTools', 'mcp__bot-query__query_structures,mcp__bot-query__query_structure_detail,mcp__bot-query__list_biomes,mcp__bot-query__locate_biome,mcp__bot-query__find_items,mcp__bot-query__inspect_blocks,mcp__bot-query__inspect_container,mcp__bot-query__query_chat_log,mcp__bot-query__search_chat_log,mcp__bot-query__search_events,mcp__bot-query__recent_events,mcp__bot-query__event_stats,mcp__bot-query__events_near,mcp__bot-query__query_task_history',
      '--no-session-persistence',
      '--include-partial-messages',
      // '--settings', '{"hooks":{}}',  // TODO: re-enable once confirmed stable
      '--system-prompt', systemPrompt,
    ]
    if (mcpConfig) {
      args.push('--mcp-config', mcpConfig)
    }

    console.log(color(c.gray, `  [AI] spawning persistent process (${model})...`))
    const thisProc = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    proc = thisProc
    state.claudeChild = thisProc
    buffer = ''
    pendingAborts = 0  // fresh process: no stale aborted-request output to drain

    thisProc.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        handleLine(line)
      }
    })

    thisProc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim()
      if (msg) console.log(color(c.red, `  [AI-ERR] ${msg}`))
    })

    thisProc.on('close', (code) => {
      // Only clear state if this is still the active process (not a stale one after respawn)
      if (proc !== thisProc) return
      console.log(color(c.yellow, `  [AI] process exited (code=${code})`))
      proc = null; ready = false; state.claudeChild = null
      if (responseResolve) {
        const r = responseResolve
        responseResolve = null
        r.reject(new Error(`AI process exited (code=${code})`))
      }
    })

    thisProc.on('error', (err) => {
      if (proc !== thisProc) return
      console.error(color(c.red, `  [AI] spawn error: ${err.message}`))
      proc = null; ready = false; state.claudeChild = null
    })
  }

  return {
    init(sysPrompt) {
      systemPrompt = sysPrompt
      spawnProc()
    },

    async send(prompt, onDelta, onToolCall) {
      if (!proc || proc.killed) { proc = null; ready = false; spawnProc() }

      // Send new request immediately — no blocking drain wait. If a previous request was
      // aborted, handleLine drains its stale events (one `result` per pending abort) before
      // collecting this response. See abort() / handleLine.
      current = { start: Date.now(), firstTokenMs: 0, text: '', usage: null, apiMs: 0, onDelta, onToolCall }

      const responsePromise = new Promise((resolve, reject) => {
        responseResolve = { resolve, reject }
      })

      // Fresh session_id per request — no stale context accumulation.
      // System prompt stays cached by the persistent process.
      // STACK + context + RECENT_FAILS provide all needed continuity.
      const sid = `s${++sessionCounter}`
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
        session_id: sid,
      }) + '\n'

      try {
        proc.stdin.write(msg)
      } catch (err) {
        responseResolve = null; current = null
        throw new Error('Failed to write to AI process: ' + err.message)
      }

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AI response timeout')), 90000)
      })

      try {
        const result = await Promise.race([responsePromise, timeoutPromise])
        return {
          text: result.text,
          usage: result.usage,
          firstTokenMs: result.firstTokenMs,
          apiMs: result.apiMs,
          totalMs: Date.now() - result.start,
        }
      } finally {
        responseResolve = null
        current = null
      }
    },

    abort() {
      if (responseResolve) {
        // The CLI can't be told to stop mid-request, so it will still emit a full `result`
        // for this aborted request. Count it so handleLine drains that stale tail instead
        // of feeding it to (or stalling) the next request.
        pendingAborts++
        const r = responseResolve
        responseResolve = null
        current = null
        r.reject(new Error('aborted'))
      }
    },

    destroy() {
      if (proc) { try { proc.kill() } catch (e) {} }
      proc = null; ready = false; state.claudeChild = null
      pendingAborts = 0
    },
  }
}

// ——— Anthropic API provider (stub) ———
//
// Placeholder for a direct Anthropic API backend (@anthropic-ai/sdk + ANTHROPIC_API_KEY).
// The provider interface at the top of this file is deliberately backend-agnostic:
// implement init/send/abort/destroy with client.messages.stream() for an API-auth
// alternative to the CLI. Note the claude-code backend gets WebSearch/WebFetch + the
// bot-query MCP tools for free via `claude -p`; an API build must add its own tool-use
// loop (dispatch bot-query calls into mcp-server.js in-process) for parity. PRs welcome.
function createAnthropicApiProvider() {
  throw new Error(
    'AI provider "anthropic-api" is not implemented — this build ships CLI-only ' +
    '(AI_PROVIDER=claude-code). Implement it in ai-provider.js to add a direct-API backend.'
  )
}

// ——— Provider registry ———

const PROVIDERS = {
  'claude-code': createClaudeCodeProvider,
  'anthropic-api': createAnthropicApiProvider,
}

function createProvider(type = process.env.AI_PROVIDER || 'claude-code', opts = {}) {
  const factory = PROVIDERS[type]
  if (!factory) throw new Error(`Unknown AI provider: ${type}. Available: ${Object.keys(PROVIDERS).join(', ')}`)
  return factory(opts)
}

module.exports = { createProvider }
