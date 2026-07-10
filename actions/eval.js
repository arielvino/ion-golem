// [ACTION:eval:TIMEOUT_MS:CODE] — debug-only sandbox runtime JS execution.
// The AI can write short async JS that runs with access to bot/state/mcData.
// Result (return value, thrown error, or console output) is pushed to eventLog
// so it appears as an event line on the next AI turn.

const state = require('../state')
const { logEvent } = require('../utils')

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor

function truncate(s, n = 400) {
  s = String(s)
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s
}

async function doEval(target) {
  if (!state.debugMode) {
    console.log('  [EVAL] refused — eval action is debug-only')
    logEvent('eval refused: bot not in --debug mode')
    return
  }

  // Parse "TIMEOUT_MS:CODE" — first colon splits timeout from code.
  const firstColon = target.indexOf(':')
  if (firstColon < 0) {
    logEvent('eval syntax error: expected TIMEOUT_MS:CODE')
    return
  }
  const timeoutMs = parseInt(target.slice(0, firstColon), 10)
  const code = target.slice(firstColon + 1)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    logEvent(`eval syntax error: bad timeout "${target.slice(0, firstColon)}"`)
    return
  }
  if (!code.trim()) {
    logEvent('eval syntax error: empty code')
    return
  }

  console.log(`  [EVAL] timeout=${timeoutMs}ms code=${truncate(code, 160)}`)

  // Capture console output produced during the eval.
  const captured = []
  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error
  const cap = (tag) => (...args) => {
    captured.push(`${tag}: ${args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()).join(' ')}`)
    origLog(...args) // still show in bot.log
  }
  console.log = cap('log')
  console.warn = cap('warn')
  console.error = cap('err')

  const bot = state.bot
  const mcData = bot ? require('minecraft-data')(bot.version) : null
  let fn
  try {
    fn = new AsyncFunction('bot', 'state', 'mcData', 'require', code)
  } catch (e) {
    console.log = origLog; console.warn = origWarn; console.error = origError
    logEvent(`eval parse error: ${truncate(e.message, 200)}`)
    return
  }

  let result
  let errored = false
  let timedOut = false
  try {
    result = await Promise.race([
      fn(bot, state, mcData, require),
      new Promise((_, rej) => setTimeout(() => { timedOut = true; rej(new Error(`eval timeout after ${timeoutMs}ms`)) }, timeoutMs)),
    ])
  } catch (e) {
    errored = true
    result = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)
  } finally {
    console.log = origLog; console.warn = origWarn; console.error = origError
  }

  // Build single-line report for eventLog.
  let report
  if (timedOut) {
    report = `eval TIMEOUT ${timeoutMs}ms`
  } else if (errored) {
    report = `eval THROW: ${truncate(result, 300)}`
  } else {
    let rstr
    try { rstr = typeof result === 'undefined' ? 'undefined' : (typeof result === 'string' ? result : JSON.stringify(result)) }
    catch { rstr = String(result) }
    report = `eval OK: ${truncate(rstr, 300)}`
  }
  if (captured.length > 0) {
    report += ` | out: ${truncate(captured.join(' ⏎ '), 300)}`
  }
  console.log(`  [EVAL] ${report}`)
  logEvent(report)
}

module.exports = { doEval }
