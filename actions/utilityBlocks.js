// Shared core of the crafting-table / furnace "reach a DB-known utility block" path.
// The OUTER selection differs by caller and stays in each caller: crafting searches
// 6 blocks then one DB candidate gated at ≤32m; smelting searches 64 blocks then
// loops DB candidates gated at <200m, with different navigate-timeout heuristics.
// This captures only the identical inner core: navigate to a known position, re-find
// the block locally, and purge it from the DB if it's no longer there.
const { navigateTo } = require('../navigation')
const { removeBlock } = require('../memory')
const state = require('../state')

// Navigate to cand (a DB row with x/y/z), then re-find blockName within 6 blocks.
// If it's gone, remove the stale DB entry. Returns the found block or null.
async function reachDbUtilityBlock(blockName, cand, timeoutMs) {
  const bot = state.bot
  const mcData = require('minecraft-data')(bot.version)
  await navigateTo(cand.x, cand.y, cand.z, 3, timeoutMs)
  const found = bot.findBlock({ matching: mcData.blocksByName[blockName]?.id, maxDistance: 6 })
  if (!found) {
    removeBlock(cand.x, cand.y, cand.z)
    console.log(`  [DB] ${blockName} was gone, removed`)
  }
  return found
}

module.exports = { reachDbUtilityBlock }
