// Inventory actions — drop, equip, unequip, give, require, take, deposit, inspect.
// (eat/sleep live in ./vitals, bucket fill lives in ./interaction)
const state = require('../core/state')
const { navigateTo } = require('../navigation/navigation')
const { sendChat, debugChat, normalizeItemName, recordFailure, fuzzyMatch } = require('../core/utils')
const { searchContainersFor, saveContainerState, removeContainerState, logGameEvent } = require('../world/memory')
const { getFurnaceState, saveContainerItems } = require('./containers')

async function doDrop(targetName) {
  const bot = state.bot
  const normalized = normalizeItemName(targetName)
  const items = bot.inventory.items()
  if (normalized === 'all') {
    for (const i of items) { await bot.tossStack(i); logGameEvent('drop', i.name, i.count, null, null, null, { reason: 'drop_all' }) }
    return
  }
  const m = items.filter(i => fuzzyMatch(i.name, normalized))
  if (m.length === 0) { sendChat(`Don't have ${targetName}!`); return }
  for (const i of m) { await bot.tossStack(i); logGameEvent('drop', i.name, i.count, null, null, null, { reason: 'drop_action' }) }
}

async function doEquip(targetName) {
  const bot = state.bot
  const normalized = normalizeItemName(targetName)
  const item = bot.inventory.items().find(i => fuzzyMatch(i.name, normalized))
  if (!item) { sendChat(`Don't have ${targetName}!`); return false }
  const name = item.name
  let dest = 'hand'
  if (name.includes('helmet') || name.includes('cap')) dest = 'head'
  else if (name.includes('chestplate') || name.includes('tunic') || name.includes('elytra')) dest = 'torso'
  else if (name.includes('leggings') || name.includes('pants')) dest = 'legs'
  else if (name.includes('boots')) dest = 'feet'
  else if (name.includes('shield')) dest = 'off-hand'
  try {
    await bot.equip(item, dest)
    logGameEvent('equip', item.name, 1, null, null, null, { slot: dest })
    console.log(`  equipped ${item.name} to ${dest}`)
    return true
  } catch (e) {
    console.log(`  equip ${item.name} to ${dest} failed: ${e.message}`)
    sendChat(`Can't equip ${item.name}: ${e.message}`)
    return false
  }
}

async function doUnequip(targetName) {
  const bot = state.bot
  const normalized = normalizeItemName(targetName)
  const slotMap = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }
  for (const [slotName, slotIdx] of Object.entries(slotMap)) {
    const slot = bot.inventory.slots[slotIdx]
    if (slot && (fuzzyMatch(slot.name, normalized) || normalized === 'all')) {
      try {
        await bot.unequip(slotName)
        console.log(`  unequipped ${slot.name} from ${slotName}`)
      } catch (e) {
        console.log(`  unequip ${slot.name} failed: ${e.message}`)
      }
      if (normalized !== 'all') return
    }
  }
}

async function doGive(targetName, username) {
  const bot = state.bot
  state.currentTask = `giving ${targetName}`
  const normalized = normalizeItemName(targetName)
  const matching = bot.inventory.items().filter(i => fuzzyMatch(i.name, normalized))
  if (matching.length === 0) { sendChat(`Don't have ${targetName}!`); state.currentTask = null; return false }
  const player = bot.players[username]
  if (player?.entity) {
    const p = player.entity.position
    await navigateTo(p.x, p.y, p.z, 2, 45000, {
      reachTarget: () => bot.players[username]?.entity?.position
    })
    try { await bot.lookAt(player.entity.position.offset(0, player.entity.height, 0)) } catch (e) {}
  }
  for (const i of matching) {
    await bot.tossStack(i)
    logGameEvent('give', i.name, i.count, null, null, null, { to: username })
  }
  console.log(`  gave ${targetName} to ${username}`)
  state.currentTask = null
  return true
}

async function doRequire(target) {
  const bot = state.bot
  const parts = target.split(':')
  const itemName = normalizeItemName(parts[0])
  const count = parts.length > 1 ? parseInt(parts[1], 10) : 1
  const have = bot.inventory.items()
    .filter(i => fuzzyMatch(i.name, itemName))
    .reduce((sum, i) => sum + i.count, 0)
  if (have >= count) {
    console.log(`  require: have ${have}/${count} ${itemName} ✓`)
    return
  }
  throw new Error(`require: have ${have}/${count} ${itemName}`)
}

const STORAGE_TYPES = new Set([
  'chest', 'trapped_chest', 'barrel',
  'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box',
  'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box',
  'gray_shulker_box', 'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box',
  'blue_shulker_box', 'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
])

async function doTake(target) {
  const bot = state.bot
  state.currentTask = `taking from storage`
  const parts = target.split(':')
  const itemName = normalizeItemName(parts[0])
  const count = parts.length > 1 ? parseInt(parts[1], 10) : 1
  let remaining = count

  const hits = searchContainersFor(itemName, bot.entity.position, 256)
    .filter(h => STORAGE_TYPES.has(h.type))

  if (hits.length === 0) throw new Error(`take: no containers with ${itemName}`)

  // Group hits by container position
  const containers = new Map()
  for (const h of hits) {
    const key = `${h.x},${h.y},${h.z}`
    if (!containers.has(key)) containers.set(key, { x: h.x, y: h.y, z: h.z, type: h.type })
  }

  for (const [, pos] of containers) {
    if (remaining <= 0) break

    const block = bot.blockAt(require('vec3')(pos.x, pos.y, pos.z))
    if (!block || !STORAGE_TYPES.has(block.name)) {
      removeContainerState(pos.x, pos.y, pos.z)
      console.log(`  take: stale container at ${pos.x},${pos.y},${pos.z} removed`)
      continue
    }

    const arrived = await navigateTo(pos.x, pos.y, pos.z, 3, 30000)
    if (!arrived) { console.log(`  take: can't reach ${pos.x},${pos.y},${pos.z}`); continue }

    let container
    try {
      container = await bot.openContainer(block)
    } catch (e) {
      console.log(`  take: can't open container at ${pos.x},${pos.y},${pos.z}: ${e.message}`)
      continue
    }

    try {
      const items = container.containerItems()
        .filter(i => fuzzyMatch(i.name, itemName))

      for (const item of items) {
        if (remaining <= 0) break
        const toTake = Math.min(item.count, remaining)
        try {
          await container.withdraw(item.type, item.metadata, toTake)
          remaining -= toTake
          logGameEvent('withdraw', item.name, toTake, pos.x, pos.y, pos.z, { container: pos.type })
          console.log(`  take: withdrew ${toTake}x ${item.name} from ${pos.x},${pos.y},${pos.z}`)
        } catch (e) {
          console.log(`  take: withdraw failed: ${e.message}`)
        }
      }

      // Update container memory with remaining contents
      saveContainerItems(pos, pos.type, container)
    } finally {
      container.close()
    }
  }

  const got = count - remaining
  state.currentTask = null
  if (remaining <= 0) {
    sendChat(`Got ${count}x ${itemName} from storage`)
    return
  }
  throw new Error(`take: got ${got}/${count} ${itemName}`)
}

async function doDeposit(target) {
  const bot = state.bot
  const parts = target.split(':')
  const itemName = normalizeItemName(parts[0])
  const count = parts.length > 1 ? parseInt(parts[1], 10) : Infinity
  const isAll = itemName === 'all'
  state.currentTask = `depositing ${isAll ? 'all items' : itemName}`

  // Find items in inventory to deposit
  const invItems = isAll
    ? bot.inventory.items()
    : bot.inventory.items().filter(i => fuzzyMatch(i.name, itemName))
  if (invItems.length === 0) {
    sendChat(`Don't have ${itemName}!`)
    state.currentTask = null
    return
  }

  // Find nearby storage containers (from memory + live scan)
  const mcData = require('minecraft-data')(bot.version)
  const storageNames = [...STORAGE_TYPES]
  const storageIds = storageNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
  const foundPositions = bot.findBlocks({ matching: storageIds, maxDistance: 64, count: 10 })
  if (foundPositions.length === 0) {
    sendChat("No chests or storage nearby!")
    recordFailure('deposit - no storage containers found within 64 blocks')
    state.currentTask = null
    return
  }

  // Sort by distance
  const pos = bot.entity.position
  foundPositions.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos))

  let totalDeposited = 0
  let remaining = isAll ? Infinity : count

  for (const containerPos of foundPositions) {
    if (!isAll && remaining <= 0) break

    const block = bot.blockAt(containerPos)
    if (!block || !STORAGE_TYPES.has(block.name)) continue

    const arrived = await navigateTo(containerPos.x, containerPos.y, containerPos.z, 3, 30000)
    if (!arrived) { console.log(`  deposit: can't reach ${containerPos.x},${containerPos.y},${containerPos.z}`); continue }

    let container
    try {
      container = await bot.openContainer(block)
    } catch (e) {
      console.log(`  deposit: can't open container at ${containerPos.x},${containerPos.y},${containerPos.z}: ${e.message}`)
      continue
    }

    try {
      // Re-check inventory each time (items change after deposits)
      const toDeposit = isAll
        ? bot.inventory.items()
        : bot.inventory.items().filter(i => fuzzyMatch(i.name, itemName))

      for (const item of toDeposit) {
        if (!isAll && remaining <= 0) break
        const amount = isAll ? item.count : Math.min(item.count, remaining)
        try {
          await container.deposit(item.type, item.metadata, amount)
          totalDeposited += amount
          if (!isAll) remaining -= amount
          logGameEvent('deposit', item.name, amount, containerPos.x, containerPos.y, containerPos.z, { container: block.name })
          console.log(`  deposit: put ${amount}x ${item.name} into ${containerPos.x},${containerPos.y},${containerPos.z}`)
        } catch (e) {
          console.log(`  deposit: failed ${item.name}: ${e.message}`)
          // Container might be full — try next one
          break
        }
      }

      // Update container memory
      saveContainerItems(containerPos, block.name, container)
    } finally {
      container.close()
    }
  }

  state.currentTask = null
  if (totalDeposited > 0) {
    sendChat(`Deposited ${totalDeposited}x ${isAll ? 'items' : itemName} into storage`)
    return
  }
  throw new Error(`deposit: couldn't deposit ${itemName} (no space or container unreachable)`)
}

async function doInspect(target) {
  const bot = state.bot
  const { Vec3 } = require('vec3')
  state.currentTask = `inspecting container`

  // Parse target — either "X,Y,Z" coords or find nearest container
  let block
  const coordMatch = target.match(/^(-?\d+),(-?\d+),(-?\d+)$/)
  if (coordMatch) {
    const pos = new Vec3(parseInt(coordMatch[1]), parseInt(coordMatch[2]), parseInt(coordMatch[3]))
    block = bot.blockAt(pos)
  } else {
    // Find nearest container
    const mcData = require('minecraft-data')(bot.version)
    const containerNames = ['chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker']
    const ids = containerNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
    block = bot.findBlock({ matching: ids, maxDistance: 32 })
  }

  if (!block || (!STORAGE_TYPES.has(block.name) && !['furnace', 'blast_furnace', 'smoker'].includes(block.name))) {
    sendChat('No container found nearby!')
    state.currentTask = null
    return
  }

  const pos = block.position
  const arrived = await navigateTo(pos.x, pos.y, pos.z, 3, 15000)
  if (!arrived) { sendChat("Can't reach the container!"); state.currentTask = null; return }

  try {
    if (['furnace', 'blast_furnace', 'smoker'].includes(block.name)) {
      const furnace = await bot.openFurnace(block)
      const contents = getFurnaceState(furnace)
      saveContainerState(pos.x, pos.y, pos.z, block.name, contents)
      furnace.close()
      const desc = Object.entries(contents).filter(([,v]) => v).map(([k,v]) => `${k}:${v.count}x${v.name}`).join(', ')
      debugChat(`[${block.name}] ${desc || 'empty'}`)
    } else {
      const container = await bot.openContainer(block)
      const items = container.containerItems().map(i => ({ name: i.name, count: i.count }))
      saveContainerItems(pos, block.name, container)
      container.close()
      if (items.length === 0) {
        debugChat(`[${block.name}] empty`)
      } else {
        debugChat(`[${block.name}] ${items.map(i => `${i.count}x${i.name}`).join(', ')}`)
      }
    }
  } catch (e) {
    console.log(`  inspect err: ${e.message}`)
    sendChat(`Can't open container: ${e.message}`)
  }
  state.currentTask = null
}

module.exports = { doDrop, doEquip, doUnequip, doGive, doRequire, doTake, doDeposit, doInspect }
