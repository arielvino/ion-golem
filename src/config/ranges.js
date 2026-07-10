// Resolves config/ranges.json. The "chunkLoad" sentinel becomes the server's
// loaded-chunk radius in blocks at runtime (serverViewDistance * 16) — the hard
// ceiling on what can be perceived, derived from the server's own view-distance
// rather than hardcoded. Read values via this module, not the raw JSON.
const raw = require('./ranges.json')
const state = require('../core/state')

// Server's announced view distance (chunks) → blocks. Falls back to 10 (the
// common default) before the login packet has set bot.game.serverViewDistance.
function chunkLoadBlocks() {
  const chunks = state.bot && state.bot.game && state.bot.game.serverViewDistance
  return (chunks && chunks > 0 ? chunks : 10) * 16
}

function resolve(v) {
  return v === 'chunkLoad' ? chunkLoadBlocks() : v
}

// Proxy resolves sentinels at access time, so callers keep using ranges.sight.foo.
const sight = new Proxy(raw.sight, { get: (t, k) => resolve(t[k]) })

module.exports = { sight, hearing: raw.hearing, chunkLoadBlocks, raw }
