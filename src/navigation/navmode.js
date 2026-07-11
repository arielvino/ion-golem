// Navigation safety-mode + transient-state helpers.
// The lowest layer of the nav stack: depends only on `state`, imports nothing
// else from navigation/, so every dig/place primitive and strategy module can
// require it without creating a cycle.
const state = require('../core/state')

// Safety mode for liveStep/digBlock/hasWalkableLOS.
// state.navSafetyMode is set by navigateTo from opts.mode ('safe'/'water'/'hazard').
// If bot is currently IN water, upgrade to at least 'water' so it can escape.
function navMode() {
  const base = state.navSafetyMode || 'safe'
  if (base === 'hazard') return 'hazard'
  if (base === 'water' || state.bot?.entity?.isInWater) return 'water'
  return 'safe'
}

// Clear all transient nav state in one place. navigateTo calls this from a
// `finally`, so every exit path (arrival, timeout, abort, thrown error) leaves
// clean state — abort paths used to leak navSafetyMode/navIntent through 7
// scattered partial clears that didn't all reset every field.
function clearNavState() {
  state.navigationStatus = null
  state.navSafetyMode = null
  state.navIntent = null
  state.navToolNeed = null
}

module.exports = { navMode, clearNavState }
