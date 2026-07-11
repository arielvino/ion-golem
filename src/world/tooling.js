// Tool-selection heuristics for digging. Two questions, one predicate + one equip:
//  - blockNeedsMissingTool: would this block drop NOTHING with what we can equip?
//    (the "I need the drop" question — drives the harvest/clear refusal)
//  - equipForDig: equip the right tool for the intent — a drop-capable one for
//    harvest, the fastest available otherwise (the "I need it cleared" question).
// Depends only on state + minecraft-data, so it's safe to require from any layer
// (navigation.js, actions/*) without forming a require cycle.
const state = require('../core/state')

let _mc = null
function mc() {
  if (!_mc) _mc = require('minecraft-data')(state.bot.version)
  return _mc
}

// After equipping, would the held item let `block` drop anything?
// Returns { needsTool, need }: needsTool=true means mining this block by hand (or
// with the wrong tier) destroys it for zero drops. `need` names a tool that WOULD
// work — prefers a pickaxe — for the AI-facing failure message.
function blockNeedsMissingTool(bot, block) {
  if (!block || !block.harvestTools) return { needsTool: false, need: null }
  const held = bot.heldItem
  if (held && block.canHarvest(held.type)) return { needsTool: false, need: null }
  const valid = Object.keys(block.harvestTools).map(id => mc().items[id]?.name).filter(Boolean)
  const need = valid.find(t => t.includes('pickaxe')) || valid[0] || 'proper tool'
  return { needsTool: true, need }
}

// Speed advisory for HAND-mineable blocks: when `block` WILL drop by hand but a
// proper tool would be MUCH faster and we aren't holding one, name the tool class
// and the rough speedup so the caller can WARN (not refuse — the drop is fine).
// Returns null when there's no meaningful speedup to gain: the block is tool-gated
// (that's the refusal path, not this), fast enough by hand already (dirt/sand/
// leaves), has no tool class, or we already hold something effective. Call AFTER
// equipForDig so bot.heldItem reflects the best tool we actually have.
function toolSpeedAdvice(bot, block) {
  if (!block || block.harvestTools) return null            // gated → refusal handles it
  const mat = block.material || ''
  if (!mat.startsWith('mineable/')) return null            // no effective tool class
  const tool = mat.slice('mineable/'.length)               // axe | shovel | pickaxe | hoe
  const handMs = block.digTime(null)
  if (handMs < 1000) return null                           // already trivial by hand — don't nag
  const held = bot.heldItem
  const heldMs = held ? block.digTime(held.type) : handMs
  if (heldMs <= handMs * 0.5) return null                  // we already hold an effective tool
  const ref = mc().itemsByName[`stone_${tool}`]            // a cheaply-craftable reference tier
  if (!ref) return null
  const factor = Math.round(handMs / block.digTime(ref.id))
  if (factor < 2) return null
  return { tool, factor }
}

// Equip a tool for digging `block`. intent 'harvest' requires a drop-capable tool
// (won't settle for a faster-but-non-harvesting one); any other intent just grabs
// the fastest available tool for speed. Best-effort — never throws; the caller
// (via blockNeedsMissingTool) decides whether to refuse or proceed.
async function equipForDig(bot, block, intent) {
  try {
    await bot.tool.equipForBlock(block, intent === 'harvest' ? { requireHarvest: true } : {})
  } catch (e) { /* no suitable tool in inventory — refusal handled by caller */ }
}

module.exports = { blockNeedsMissingTool, toolSpeedAdvice, equipForDig }
