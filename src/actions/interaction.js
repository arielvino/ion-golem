// Interaction actions — use/activate blocks (doors, trapdoors, buttons, levers, etc.)
// and bucket fill (item-use on a liquid source).
const state = require('../core/state')
const { stopAll, sleep } = require('../core/tick')
const { Vec3 } = require('vec3')
const { navigateTo } = require('../navigation/navigation')
const { sendChat, normalizeItemName, fuzzyMatch, parseCoordTarget, recordFailure } = require('../core/utils')
const { findKnownBlocks, reachKnownBlock } = require('../perception/touch')
const { c, color } = require('../lib/colors')

async function doUse(target) {
  stopAll()
  const bot = state.bot
  const mcData = require('minecraft-data')(bot.version)
  state.currentTask = `using ${target}`

  // Parse target — "block:X,Y,Z" coords, or the nearest block of that name the bot has seen
  let pos = null
  let accept = b => b.name !== 'air'
  let label = target
  const coord = parseCoordTarget(target)
  if (coord) {
    pos = new Vec3(coord.x, coord.y, coord.z)
    label = coord.name || 'block'
  } else {
    const normalized = normalizeItemName(target)
    const names = Object.keys(mcData.blocksByName).filter(name => fuzzyMatch(name, normalized))
    if (names.length === 0) {
      sendChat(`Don't know block "${target}"!`)
      recordFailure(`use:${target} - not a block; use works on blocks only (trade with villagers, mount vehicles)`)
      state.currentTask = null
      return false
    }
    const known = findKnownBlocks(names, { maxDistance: 32, count: 1 })
    if (known.length === 0) {
      sendChat(`Can't find ${target} nearby!`)
      recordFailure(`use:${target} - none seen within 32 blocks`)
      state.currentTask = null
      return false
    }
    pos = known[0].pos
    accept = b => names.includes(b.name)
    label = known[0].name || target
  }

  // Walk up to it; use it only when it is in reach and in sight
  const r = await reachKnownBlock(pos, accept, label, 30000)
  if (!r.block) {
    state.currentTask = null
    if (r.why === 'aborted') return
    sendChat(`Can't use ${label}!`)
    recordFailure(`use:${target} - ${r.why}`)
    return false
  }
  const block = r.block

  try {
    await bot.activateBlock(block)
    console.log(color(c.green, `  used ${block.name} at ${block.position.x},${block.position.y},${block.position.z}`))
    sendChat(`Used ${block.name}!`)
  } catch (err) {
    console.error(`  use err: ${err.message}`)
    sendChat(`Failed to use ${block.name}!`)
    recordFailure(`use:${target} - ${err.message}`)
    state.currentTask = null
    return false
  }
  state.currentTask = null
}

async function doFill(targetName) {
  const bot = state.bot
  const { Vec3 } = require('vec3')
  const normalized = normalizeItemName(targetName)

  // Determine what liquid to fill with
  let liquidName = 'water'
  if (normalized.includes('lava')) liquidName = 'lava'

  // Find empty bucket in inventory
  const bucket = bot.inventory.items().find(i => i.name === 'bucket')
  if (!bucket) { sendChat("I don't have an empty bucket!"); recordFailure(`fill:${targetName} - no empty bucket in inventory`); return false }

  // Find nearest liquid source block
  const mcData = require('minecraft-data')(bot.version)
  const liquidBlock = mcData.blocksByName[liquidName]
  if (!liquidBlock) { sendChat(`Unknown liquid: ${liquidName}`); recordFailure(`fill:${targetName} - unknown liquid ${liquidName}`); return false }

  // Find source blocks (metadata 0 = still/source, not flowing) — only ones in sight
  const allLiquid = findKnownBlocks([liquidName], { maxDistance: 32, count: 100 })
    .filter(k => k.seen === 'now').map(k => k.pos)
  const sources = allLiquid.filter(pos => {
    const b = bot.blockAt(pos)
    return b && b.metadata === 0
  })
  const targets = sources.length > 0 ? sources : allLiquid
  if (targets.length === 0) {
    sendChat(`Can't find ${liquidName} nearby!`)
    recordFailure(`fill:${targetName} - no ${liquidName} seen nearby`)
    return false
  }

  // Find a source block we can reach from solid ground (not standing IN the liquid)
  const SOLID_OFFSETS = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    new Vec3(1, 0, 1), new Vec3(-1, 0, 1),
    new Vec3(1, 0, -1), new Vec3(-1, 0, -1),
    new Vec3(0, 1, 0), // above
    new Vec3(1, 1, 0), new Vec3(-1, 1, 0),
    new Vec3(0, 1, 1), new Vec3(0, 1, -1),
  ]
  const TRANSPARENT = new Set(['air', 'cave_air', 'void_air', 'tall_grass', 'short_grass', 'grass'])

  let standPos = null
  let chosenTarget = null
  for (const target of targets) {
    for (const off of SOLID_OFFSETS) {
      const sp = target.plus(off)
      const blockAtSp = bot.blockAt(sp)
      const blockAboveSp = bot.blockAt(sp.offset(0, 1, 0))
      const blockBelowSp = bot.blockAt(sp.offset(0, -1, 0))
      // Need: feet position is passable, head is passable, ground below is solid
      if (blockAtSp && TRANSPARENT.has(blockAtSp.name) &&
          blockAboveSp && TRANSPARENT.has(blockAboveSp.name) &&
          blockBelowSp && !TRANSPARENT.has(blockBelowSp.name) &&
          blockBelowSp.name !== liquidName) {
        standPos = sp
        chosenTarget = target
        break
      }
    }
    if (standPos) break
  }

  if (!standPos) {
    // Fallback: just navigate near closest source
    chosenTarget = targets[0]
    console.log('  no ideal stand pos found, navigating near source')
  }

  // Navigate to stand position (solid ground next to water)
  const navTarget = standPos || chosenTarget
  const dist = bot.entity.position.distanceTo(navTarget)
  if (dist > 3) {
    const arrived = await navigateTo(navTarget.x, navTarget.y, navTarget.z, 2, 30000)
    if (!arrived) { sendChat(`Can't reach the ${liquidName}!`); recordFailure(`fill:${targetName} - couldn't reach the ${liquidName} at ${navTarget.x},${navTarget.y},${navTarget.z}${state.navFailReason ? ` (${state.navFailReason})` : ''}`); return false }
  }
  await sleep(300)

  // Re-fetch the block reference after navigation (may have changed)
  const block = bot.blockAt(chosenTarget)
  if (!block || block.name !== liquidName) {
    sendChat(`${liquidName} block disappeared!`)
    recordFailure(`fill:${targetName} - the ${liquidName} at ${chosenTarget.x},${chosenTarget.y},${chosenTarget.z} is gone`)
    return false
  }

  // Equip bucket
  await bot.equip(bucket, 'hand')
  await sleep(200)

  for (let attempt = 0; attempt < 3; attempt++) {
    // Re-check bucket is equipped
    const heldItem = bot.heldItem
    if (!heldItem || heldItem.name !== 'bucket') {
      const b2 = bot.inventory.items().find(i => i.name === 'bucket')
      if (!b2) { console.log('  no more empty buckets'); break }
      await bot.equip(b2, 'hand')
      await sleep(200)
    }

    await bot.lookAt(chosenTarget.offset(0.5, 0.5, 0.5))
    await sleep(200)

    // use_item carries the look rotation, which the server raycasts along (1.21.2+)
    bot.activateItem()
    await sleep(600)

    // Check if we got the filled bucket
    const filled = bot.inventory.items().find(i => i.name === `${liquidName}_bucket`)
    if (filled) {
      console.log(`  filled ${liquidName} bucket (attempt ${attempt + 1})`)
      return true
    }
    console.log(`  use_item attempt ${attempt + 1} didn't fill, retrying...`)
  }

  console.log(`  fill bucket failed all attempts`)
  sendChat(`Can't fill bucket here`)
  recordFailure(`fill:${targetName} - 3 tries at ${chosenTarget.x},${chosenTarget.y},${chosenTarget.z} left the bucket empty`)
  return false
}

module.exports = { doUse, doFill }
