// Background task manager — runs actions as detached promises, auto-chains on success
// Supports fallback chains: "A|B|C" tries each alternative left-to-right, stops on first success
const state = require('./state')
const { AbortError } = require('./tick')
const { logEvent, recordFailure } = require('./utils')

let executeFnRef = null  // stored on first launch so chaining can call it

function drainNext() {
  if (state.abortSignal || state.actionQueue.length === 0) return
  const next = state.actionQueue.shift()
  state.lastActionUsername = next.username
  launchBackground(next.actionStr, next.username, executeFnRef)
}

function launchBackground(actionStr, username, executeFn) {
  executeFnRef = executeFn
  const alternatives = actionStr.split('|')
  const firstAlt = alternatives[0]
  const action = firstAlt.split(':')[0]
  const target = firstAlt.split(':').slice(1).join(':')
  const task = {
    action, target, actionStr, username,
    startedAt: Date.now(), status: 'running', error: null,
    currentAlt: 0, totalAlts: alternatives.length,
  }
  state.backgroundTask = task

  ;(async () => {
    for (let i = 0; i < alternatives.length; i++) {
      if (state.abortSignal) throw new AbortError('aborted')

      const alt = alternatives[i]
      const altAction = alt.split(':')[0]
      const altTarget = alt.split(':').slice(1).join(':')
      task.action = altAction
      task.target = altTarget
      task.currentAlt = i

      const isLast = i === alternatives.length - 1
      const succeeded = await executeFn(alt, username, isLast ? {} : { quiet: true })

      if (succeeded) {
        if (alternatives.length > 1 && i > 0) {
          logEvent(`fallback ${altAction}:${altTarget} succeeded (alt ${i + 1}/${alternatives.length})`)
        }
        return  // success — goes to .then()
      }

      // Failed — log transition and try next alternative
      if (!isLast) {
        const nextAlt = alternatives[i + 1].split(':')[0]
        logEvent(`${altAction}:${altTarget} failed, trying ${nextAlt} (alt ${i + 2}/${alternatives.length})`)
      }
    }
    // All alternatives exhausted
    throw new Error(`all ${alternatives.length} alternatives failed for: ${actionStr}`)
  })()
    .then(() => { if (task.status === 'running') task.status = 'done' })
    .catch(err => {
      if (err instanceof AbortError || err.message?.includes('abort'))
        task.status = 'aborted'
      else {
        task.status = 'failed'
        task.error = err.message
        // The handler already recorded a specific reason (recordFailure) and the engine
        // logged `${action} failed` to HISTORY. Only add a note for multi-alternative
        // chains, where "every fallback failed" is information the handler can't give.
        if (task.totalAlts > 1) recordFailure(`${task.actionStr} - all ${task.totalAlts} alternatives failed`)
        state.actionQueue = []  // drop remaining queue on failure
      }
    })
    .finally(() => {
      state.currentTask = null
      // Auto-chain: if task succeeded and more actions queued, launch next immediately
      if (task.status === 'done') drainNext()
    })
}

function isBackgroundRunning() {
  return state.backgroundTask?.status === 'running'
}

function consumeBackgroundResult() {
  const t = state.backgroundTask
  if (!t || t.status === 'running') return null
  state.backgroundTask = null
  return t
}

function getBackgroundSummary() {
  const t = state.backgroundTask
  if (!t) return null
  const sec = Math.round((Date.now() - t.startedAt) / 1000)
  const fallbackInfo = t.totalAlts > 1 ? ` (fallback ${t.currentAlt + 1}/${t.totalAlts})` : ''
  if (t.status === 'running') {
    const nav = state.navigationStatus || ''
    return `${t.action}:${t.target}${fallbackInfo} (${sec}s${nav ? ', ' + nav : ''})`
  }
  return `${t.action}:${t.target} ${t.status}${t.error ? ': ' + t.error : ''} (${sec}s)`
}

module.exports = { launchBackground, isBackgroundRunning, consumeBackgroundResult, getBackgroundSummary }
