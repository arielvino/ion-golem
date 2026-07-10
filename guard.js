// Action guard — wraps atomic operations with safety checks
const state = require('./state')
const { AbortError } = require('./tick')
const { HEALTH_CRITICAL, OXYGEN_LOW } = require('./config/safety')
const { WATER_BLOCKS } = require('./config/blocks')

class ThreatError extends Error {
  constructor(entity) {
    super(`Hostile nearby: ${entity.name || 'unknown'}`)
    this.name = 'ThreatError'
    this.entity = entity
  }
}

class CriticalError extends Error {
  constructor(reason) {
    super(`Critical: ${reason}`)
    this.name = 'CriticalError'
    this.reason = reason
  }
}

// Scan for hostile mobs within range
function scanHostiles(range = 12) {
  const bot = state.bot
  if (!bot?.entity) return null
  const pos = bot.entity.position
  return bot.nearestEntity(e =>
    e.type === 'hostile' &&
    e.position.distanceTo(pos) < range
  )
}

// Run pre-checks before an atomic step
// opts: { ignoreHostiles, ignoreMsgs, hostileRange, allowLowHealth }
function preCheck(opts = {}) {
  if (state.abortSignal) throw new AbortError()

  if (!opts.ignoreMsgs && state.messageQueue.length > 0) {
    // Don't throw — just flag. Let the caller decide to yield
    return { interrupt: 'chat' }
  }

  if (!opts.allowLowHealth) {
    const bot = state.bot
    if (bot && bot.health <= HEALTH_CRITICAL) return { interrupt: 'low_health' }
    // Only flag drowning if head is actually in water — oxygenLevel can be stale
    if (bot && bot.oxygenLevel <= OXYGEN_LOW && bot.entity?.isInWater) {
      try {
        const { Vec3 } = require('vec3')
        const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))
        if (head && WATER_BLOCKS.has(head.name)) {
          return { interrupt: 'drowning' }
        }
      } catch (e) { console.warn('  [GUARD] drowning check err:', e.message) }
    }
  }

  if (!opts.ignoreHostiles) {
    const hostile = scanHostiles(opts.hostileRange || 12)
    if (hostile) return { interrupt: 'hostile', entity: hostile }
  }

  return null
}

// Wrap an async step function with guard checks
// Returns: { ok: true, result } or { ok: false, reason, entity? }
async function guarded(stepFn, opts = {}) {
  const check = preCheck(opts)
  if (check) {
    if (check.interrupt === 'hostile' && !opts.ignoreHostiles) {
      return { ok: false, reason: 'hostile', entity: check.entity }
    }
    if (check.interrupt === 'chat' && !opts.ignoreMsgs) {
      return { ok: false, reason: 'chat' }
    }
    if (check.interrupt === 'low_health') {
      return { ok: false, reason: 'low_health' }
    }
    if (check.interrupt === 'drowning') {
      return { ok: false, reason: 'drowning' }
    }
  }

  try {
    const result = await stepFn()
    return { ok: true, result }
  } catch (err) {
    if (err instanceof AbortError) throw err
    return { ok: false, reason: 'error', error: err }
  }
}

module.exports = { guarded, preCheck, scanHostiles, ThreatError, CriticalError }
