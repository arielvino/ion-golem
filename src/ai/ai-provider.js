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
const state = require('../core/state')
const { c, color } = require('../lib/colors')

// ——— Claude Code CLI provider (claude -p with stream-json) ———

function createClaudeCodeProvider(opts = {}) {
  const model = opts.model || process.env.AI_MODEL || 'sonnet'
  let proc = null
  let ready = false
  let responseResolve = null
  let buffer = ''
  let current = null  // { start, firstTokenMs, text, usage, apiMs, onDelta, gen }
  let pendingAborts = 0  // # of `result`s to drain unseen: aborted requests + our own /clear
  let systemPrompt = ''
  let reqSeq = 0  // per-request counter; names the interrupt control_request

  function handleLine(line) {
    let event
    try { event = JSON.parse(line) } catch (e) { return }

    // Init event — process is ready. Every /clear starts a new session and emits
    // another init, so only the first one per process is news.
    if (event.type === 'system' && event.subtype === 'init') {
      if (!ready) console.log(color(c.gray, `  [AI] persistent process ready (${model})`))
      ready = true
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
      // A turn that calls tools spans several assistant messages; keep their text
      // blocks apart so a tag at the end of one can't fuse with prose opening the next.
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && current.text) {
        current.text += '\n'
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (!current.firstTokenMs) current.firstTokenMs = Date.now() - current.start
        current.text += ev.delta.text
        if (current.onDelta) current.onDelta(ev.delta.text, current.text)
      }
      // Detect tool calls (web search/fetch) — announce in chat
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        const short = ev.content_block.name || ''
        if (short) {
          console.log(color(c.gray, `  [AI] tool call: ${short}`))
          if (current.onToolCall) current.onToolCall(short)
        }
      }
    }

    // Non-streaming fallback: full assistant message
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        // Full tool call with its arguments — the streamed start event only has the
        // name, and "why did it query that?" needs the what.
        if (block.type === 'tool_use') {
          const short = block.name || ''
          console.log(color(c.gray, `  [AI] tool args: ${short} ${JSON.stringify(block.input || {}).slice(0, 300)}`))
        }
        // Only when nothing streamed: each assistant event carries just ITS message's
        // text, so overwriting would drop every earlier message of a tool-using turn.
        if (block.type === 'text' && block.text && !current.firstTokenMs) current.text = block.text
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

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--tools', 'WebSearch,WebFetch',
      // The bot's own queries (builds, chat, events, records) are [CTX:...] views
      // answered in the next turn, not MCP tools: an in-turn tool always beats a
      // next-turn channel, and the model spent whole turns in query sprees. Only
      // the web tools stay in-turn.
      '--allowedTools', 'WebSearch,WebFetch',
      '--no-session-persistence',
      '--include-partial-messages',
      // '--settings', '{"hooks":{}}',  // TODO: re-enable once confirmed stable
      '--system-prompt', systemPrompt,
      // No --mcp-config, so this means no MCP servers at all. Without it the CLI
      // loads the user's account-level servers, and the model wandered into those.
      '--strict-mcp-config',
      // Without it the CLI injects the CLAUDE.md files it finds (user-global and
      // the repo's — our development instructions) and the auto-memory index into
      // every turn after /clear: ~4.8k tokens the bot has no business reading.
      // Auth and the web tools work unchanged.
      '--safe-mode',
    ]

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
      reqSeq++

      const responsePromise = new Promise((resolve, reject) => {
        responseResolve = { resolve, reject }
      })

      // Every request starts from an empty conversation: AGENDA + context + NOTES +
      // NEW= + RECENT_FAILS carry all the continuity the model needs. A per-message session_id
      // does NOT do this — stream-json input ignores it and the process keeps one
      // growing conversation (measured: +~1.3k tokens/turn, 48k → 135k in ~65 turns,
      // then 90s timeouts). `/clear` does: it costs no API call, the system prompt stays
      // cached, and it emits one empty `result` that handleLine drains like an abort's.
      const line = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'

      try {
        proc.stdin.write(line('/clear'))
        pendingAborts++
        proc.stdin.write(line(prompt))
      } catch (err) {
        responseResolve = null; current = null
        throw new Error('Failed to write to AI process: ' + err.message)
      }

      let timer = null
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('AI response timeout')), 90000)
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
        clearTimeout(timer)
        responseResolve = null
        current = null
      }
    },

    abort() {
      if (responseResolve) {
        // Actually stop the CLI's turn. Without this the "aborted" request kept running to
        // the end — measured up to 85s when it made tool calls — and the next request
        // queued behind it until the 90s timeout killed the process. An interrupt ends the
        // turn at once with its own `result` (subtype error_during_execution), so the
        // one-result-per-request drain accounting below still holds.
        try {
          proc?.stdin.write(JSON.stringify({ type: 'control_request', request_id: `abort-${reqSeq}`, request: { subtype: 'interrupt' } }) + '\n')
        } catch (e) { console.warn(`  [AI] interrupt write failed: ${e.message}`) }
        // Count the interrupted request's `result` so handleLine drains that stale tail
        // instead of feeding it to (or stalling) the next request.
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
// alternative to the CLI. Note the claude-code backend gets WebSearch/WebFetch for free
// via `claude -p`; an API build must add the server-side web tools for parity (the
// bot's own queries are [CTX:...] tags, so they need nothing). PRs welcome.
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
