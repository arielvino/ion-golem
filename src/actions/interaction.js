// Interaction actions — use/activate blocks (doors, trapdoors, buttons, levers, etc.)
// and bucket fill (item-use on a liquid source).
const state = require('../core/state')
const { stopAll, sleep } = require('../core/tick')
const { navigateTo } = require('../navigation/navigation')
const { sendChat, normalizeItemName, fuzzyMatch, parseCoordTarget } = require('../core/utils')
const { c, color } = require('../lib/colors')

async function doUse(target) {
  stopAll()
  const bot = state.bot
  const mcData = require('minecraft-data')(bot.version)
  state.currentTask = `using ${target}`

  let block = null

  // Parse target — could be "block:X,Y,Z" coords or just a block name
  const coord = parseCoordTarget(target)
  if (coord) {
    const { x, y, z } = coord
    block = bot.blockAt(new (require('vec3').Vec3)(x, y, z))
    if (!block || block.name === 'air') {
      sendChat(`No block at ${x},${y},${z}!`)
      state.currentTask = null
      return
    }
  } else {
    // Search for block by name nearby
    const normalized = normalizeItemName(target)
    const matchingBlocks = Object.entries(mcData.blocksByName)
      .filter(([name]) => fuzzyMatch(name, normalized))
      .map(([, b]) => b.id)

    if (matchingBlocks.length === 0) {
      sendChat(`Don't know block "${target}"!`)
      state.currentTask = null
      return
    }

    block = bot.findBlock({ matching: matchingBlocks, maxDistance: 32 })
    if (!block) {
      sendChat(`Can't find ${target} nearby!`)
      state.currentTask = null
      return
    }
  }

  // Navigate to the block
  const dist = bot.entity.position.distanceTo(block.position)
  if (dist > 3) {
    await navigateTo(block.position.x, block.position.y, block.position.z, 3, 30000)
  }

  // Re-fetch block in case we moved
  block = bot.blockAt(block.position)
  if (!block || block.name === 'air') {
    sendChat(`Block disappeared!`)
    state.currentTask = null
    return
  }

  try {
    await bot.activateBlock(block)
    console.log(color(c.green, `  used ${block.name} at ${block.position.x},${block.position.y},${block.position.z}`))
    sendChat(`Used ${block.name}!`)
  } catch (err) {
    console.error(`  use err: ${err.message}`)
    sendChat(`Failed to use ${block.name}!`)
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
  if (!bucket) { sendChat("I don't have an empty bucket!"); return false }

  // Find nearest liquid source block
  const mcData = require('minecraft-data')(bot.version)
  const liquidBlock = mcData.blocksByName[liquidName]
  if (!liquidBlock) { sendChat(`Unknown liquid: ${liquidName}`); return false }

  // Find source blocks (metadata 0 = still/source, not flowing)
  const allLiquid = bot.findBlocks({
    matching: liquidBlock.id,
    maxDistance: 32,
    count: 100,
  })
  const sources = allLiquid.filter(pos => {
    const b = bot.blockAt(pos)
    return b && b.metadata === 0
  })
  const targets = sources.length > 0 ? sources : allLiquid
  if (targets.length === 0) {
    sendChat(`Can't find ${liquidName} nearby!`)
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
    if (!arrived) { sendChat(`Can't reach the ${liquidName}!`); return false }
  }
  await sleep(300)

  // Re-fetch the block reference after navigation (may have changed)
  const block = bot.blockAt(chosenTarget)
  if (!block || block.name !== liquidName) {
    sendChat(`${liquidName} block disappeared!`)
    return false
  }

  // Equip bucket
  await bot.equip(bucket, 'hand')
  await sleep(200)

  // Use raw use_item packet — mineflayer's activateItem() is broken on 1.21+
  // (sends rotation {0,0} instead of actual yaw/pitch, so server doesn't know
  // the bot is aiming at water). See: github.com/PrismarineJS/mineflayer/issues/3731
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

    // Send raw use_item with the bot's actual look direction
    bot._client.write('use_item', {
      hand: 0,
      sequence: 0,
      rotation: {
        x: bot.entity.yaw,
        y: bot.entity.pitch
      }
    })
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
  return false
}

module.exports = { doUse, doFill }
