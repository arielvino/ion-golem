// unbury — dig out of a block the bot is stuck inside (gravel or sand fallen onto it, a
// tunnel caving in). Launched by the suffocation reflex (autonomous.js), never waits for the
// model: suffocating costs 1 HP every half second, and a model turn takes 5-10 s (#196).
//
// Head first (suffocation is the block at the eyes), then feet; again while more falls into
// the cells. Then, if falling blocks still hang over the column, step to an open neighbour.
// It may read the live world: this is the bot's own body and the cells touching it.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { sleep, isAborted, raceAbort } = require('../core/tick')
const { logEvent, recordFailure } = require('../core/utils')
const { digBlock, FALLS } = require('../navigation/navigation')

const TIME_MS = 20000    // give up after this long
const SETTLE_MS = 300     // a falling block takes this long to land in the dug cell
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

const solid = (b) => b && b.boundingBox === 'block'

// Feet and head cells of the column the bot stands in.
function body(bot) {
  const p = bot.entity.position
  const feet = new Vec3(Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z))
  return { feet, head: feet.offset(0, 1, 0) }
}

// A neighbour column the bot can step into: feet and head open, solid ground, nothing
// about to fall on it.
function openSide(bot, feet) {
  for (const [dx, dz] of SIDES) {
    const f = feet.offset(dx, 0, dz)
    const [floor, low, high, over] = [-1, 0, 1, 2].map(dy => bot.blockAt(f.offset(0, dy, 0)))
    if (!solid(floor) || solid(low) || solid(high) || FALLS(over?.name || '')) continue
    if (/lava|water|fire/.test(`${low?.name} ${high?.name}`)) continue
    return f
  }
  return null
}

// More is coming down onto the column: a falling block resting on it, or one in the air above.
function coming(bot, head) {
  if (FALLS(bot.blockAt(head.offset(0, 1, 0))?.name || '')) return true
  return Object.values(bot.entities).some(e => e.name === 'falling_block' &&
    Math.floor(e.position.x) === head.x && Math.floor(e.position.z) === head.z && e.position.y >= head.y)
}

async function stepTo(bot, to) {
  await bot.lookAt(new Vec3(to.x + 0.5, to.y + 1.6, to.z + 0.5), true)
  bot.setControlState('forward', true)
  const deadline = Date.now() + 1500
  while (Date.now() < deadline && !isAborted()) {
    // The middle of the cell, not just into it: at its edge the body still reaches into the
    // column, and the block that lands there goes on suffocating it.
    const p = bot.entity.position
    if (Math.abs(p.x - to.x - 0.5) < 0.2 && Math.abs(p.z - to.z - 0.5) < 0.2) break
    await sleep(50)
  }
  bot.setControlState('forward', false)
}

// A torch on the lowest solid block of the bot's column (the feet block, or the floor once
// that is dug). Falling gravel or sand that lands on a torch drops as an item.
async function torchUnder(bot, feet) {
  const torch = bot.inventory.items().find(i => i.name === 'torch')
  if (!torch) return false
  const support = solid(bot.blockAt(feet)) ? bot.blockAt(feet) : bot.blockAt(feet.offset(0, -1, 0))
  if (!solid(support)) return false
  try {
    await bot.equip(torch, 'hand')
    await raceAbort(bot.placeBlock(support, new Vec3(0, 1, 0)), 1500)
    return true
  } catch (e) {
    console.log(`  [unbury] torch: ${e.message}`)
    return false
  }
}

async function doUnbury() {
  const bot = state.bot
  state.currentTask = 'digging out'
  const hp0 = Math.round(bot.health)
  let dug = 0, stuckOn = null, stepped = false, torched = false
  const deadline = Date.now() + TIME_MS
  while (Date.now() < deadline && !isAborted()) {
    const { feet, head } = body(bot)
    // The torch is breaking the fall: keep the feet block it stands on until the column is spent.
    if (torched && !solid(bot.blockAt(head)) && coming(bot, head)) { await sleep(150); continue }
    for (const c of [head, feet]) {
      if (!solid(bot.blockAt(c))) continue
      const name = bot.blockAt(c)?.name
      const r = await digBlock(c, { intent: 'clear-no-tool', reason: 'unbury', ignorePathBlocks: true, ignorePlacedBlocks: true })
      if (r.ok) dug++
      else stuckOn = `${name} at ${c.x},${c.y},${c.z}: ${r.reason}`
    }
    const clear = !solid(bot.blockAt(head)) && !solid(bot.blockAt(feet))
    if (clear && !coming(bot, head)) break
    // Out of the blocks with more on the way: leave the column before it lands.
    if (clear) {
      const to = openSide(bot, feet)
      if (to) { await stepTo(bot, to); stepped = true; break }
    }
    // Nowhere to step (a 1-wide corridor) and the column keeps refilling the head: a torch
    // where the next block lands breaks each one into an item, as a player does.
    if (!torched && !solid(bot.blockAt(head)) && coming(bot, head) && await torchUnder(bot, feet)) torched = true
    await sleep(SETTLE_MS)
  }
  state.currentTask = null
  const now = body(bot)
  const free = !solid(bot.blockAt(now.head)) && !solid(bot.blockAt(now.feet))
  const msg = `dug ${dug} block${dug === 1 ? '' : 's'}${stepped ? ', stepped aside' : ''}${torched ? ', torch under the fall' : ''}, HP ${hp0}→${Math.round(bot.health)}, at ${now.feet.x},${now.feet.y},${now.feet.z}`
  console.log(`  [unbury] ${free ? 'free' : 'still stuck'}: ${msg}`)
  if (free) { logEvent(`reflex: buried in a block → dug myself out (${msg})`); return true }
  recordFailure(`unbury: still stuck inside a block (${stuckOn || 'more kept falling'}); ${msg}`)
  return false
}

module.exports = { doUnbury }
