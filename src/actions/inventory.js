// Inventory actions — drop, equip, unequip, give, require, take, deposit, inspect.
// (eat/sleep live in ./vitals, bucket fill lives in ./interaction)
const state = require('../core/state')
const { Vec3 } = require('vec3')
const { isAborted } = require('../core/tick')
const { doCome } = require('./movement')
const { sendChat, debugChat, normalizeItemName, recordFailure, fuzzyMatch, resolvePlayerName, logEvent } = require('../core/utils')
const { searchContainersFor, saveContainerState, removeContainerState, logGameEvent } = require('../world/memory')
const { getFurnaceState, saveContainerItems } = require('./containers')
const { findKnownBlocks, reachKnownBlock } = require('../perception/touch')

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
  if (!item) { sendChat(`Don't have ${targetName}!`); recordFailure(`equip:${targetName} - not in inventory`); return false }
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
    recordFailure(`equip:${targetName} - ${e.message}`)
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

// [ACTION:give:ITEM[:COUNT]:PLAYER] — walk to the player and toss them the item.
// The recipient is the named player, else whoever asked, else the player the
// current task names (autonomous turns run as 'self', which is nobody). Every
// refusal is recorded with its reason, so the model can act on it.
async function doGive(arg) {
  const bot = state.bot
  const parts = String(arg || '').split(':').map(s => s.trim()).filter(Boolean)
  const others = Object.keys(bot.players).filter(n => n !== bot.username)
  const isPlayer = (s) => others.some(n => n.toLowerCase() === String(s).toLowerCase())
  const invNames = [...new Set(bot.inventory.items().map(i => i.name))]

  let [itemArg, second, third] = parts
  if (!itemArg) { recordFailure('give: name an item — give:ITEM[:COUNT]:PLAYER'); return false }
  if (isPlayer(itemArg) && !invNames.some(n => fuzzyMatch(n, normalizeItemName(itemArg)))) {
    recordFailure(`give:${itemArg}: that's a player, not an item — use give:ITEM:${itemArg} (you carry: ${invNames.join(', ') || 'nothing'})`)
    return false
  }
  let count = null, playerArg = null
  if (/^\d+$/.test(second || '')) { count = Number(second); playerArg = third || null } else playerArg = second || null

  const item = normalizeItemName(itemArg)
  const matching = bot.inventory.items().filter(i => fuzzyMatch(i.name, item))
  if (matching.length === 0) {
    recordFailure(`give:${itemArg}: I don't have any ${itemArg} (you carry: ${invNames.join(', ') || 'nothing'})`)
    return false
  }
  const to = resolvePlayerName(playerArg)
  if (!to) {
    recordFailure(`give:${arg}: who to? ${playerArg ? `${playerArg} is not online` : 'name the player — give:ITEM:PLAYER'}`)
    return false
  }

  state.currentTask = `giving ${itemArg} to ${to}`
  await doCome(to)
  if (isAborted()) { state.currentTask = null; return }
  const target = bot.players[to]?.entity
  const dist = target ? bot.entity.position.distanceTo(target.position) : Infinity
  if (!target || dist > 3.5) {
    state.currentTask = null
    recordFailure(`give:${itemArg}:${to}: couldn't get close enough to toss it (${target ? `${dist.toFixed(1)}m away` : `can't see ${to}`})`)
    return false
  }
  try { await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0)) } catch (e) { /* toss anyway */ }

  let left = count ?? Infinity, given = 0
  for (const i of matching) {
    if (left <= 0) break
    const n = Math.min(i.count, left)
    if (n === i.count) await bot.tossStack(i)
    else await bot.toss(i.type, i.metadata, n)
    given += n; left -= n
    logGameEvent('give', i.name, n, null, null, null, { to })
  }
  // The gift lands within the pickup reflex's reach: keep it from racing the
  // recipient for it (thrown items are grabbable by anyone after 2s).
  state.pickupPausedUntil = Date.now() + 10000
  console.log(`  gave ${given} ${itemArg} to ${to} (${dist.toFixed(1)}m)`)
  logEvent(`give: tossed ${given} ${matching[0].name} to ${to} from ${dist.toFixed(1)}m`)
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
  const whyNot = []

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

    const r = await reachKnownBlock(new Vec3(pos.x, pos.y, pos.z), b => STORAGE_TYPES.has(b.name), pos.type, 30000)
    if (isAborted()) break
    if (!r.block) {
      if (r.gone) removeContainerState(pos.x, pos.y, pos.z)
      console.log(`  take: ${r.why}`)
      whyNot.push(r.why)
      continue
    }
    const block = r.block

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
  throw new Error(`take: got ${got}/${count} ${itemName}${whyNot.length ? ` (${whyNot.join('; ')})` : ''}`)
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

  // Storage the bot has seen, now or before
  const storageNames = [...STORAGE_TYPES]
  const foundPositions = findKnownBlocks(storageNames, { maxDistance: 64, count: 10 }).map(k => k.pos)
  if (foundPositions.length === 0) {
    sendChat("No chests or storage nearby!")
    recordFailure('deposit - no storage container seen within 64 blocks')
    state.currentTask = null
    return
  }

  // Sort by distance
  const pos = bot.entity.position
  foundPositions.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos))

  let totalDeposited = 0
  const whyNot = []
  let remaining = isAll ? Infinity : count

  for (const containerPos of foundPositions) {
    if (!isAll && remaining <= 0) break

    const r = await reachKnownBlock(containerPos, b => STORAGE_TYPES.has(b.name), 'container', 30000)
    if (isAborted()) break
    if (!r.block) { console.log(`  deposit: ${r.why}`); whyNot.push(r.why); continue }
    const block = r.block

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
  throw new Error(`deposit: couldn't deposit ${itemName} (${whyNot.length ? whyNot.join('; ') : 'no space'})`)
}

async function doInspect(target) {
  const bot = state.bot
  state.currentTask = `inspecting container`

  // Parse target — either "X,Y,Z" coords or the nearest container the bot has seen
  const FURNACES = ['furnace', 'blast_furnace', 'smoker']
  let pos
  const coordMatch = target.match(/^(-?\d+),(-?\d+),(-?\d+)$/)
  if (coordMatch) {
    pos = new Vec3(parseInt(coordMatch[1]), parseInt(coordMatch[2]), parseInt(coordMatch[3]))
  } else {
    const known = findKnownBlocks(['chest', 'trapped_chest', 'barrel', ...FURNACES], { maxDistance: 32, count: 1 })
    if (known.length === 0) {
      sendChat('No container found nearby!')
      recordFailure('inspect - no container seen within 32 blocks')
      state.currentTask = null
      return
    }
    pos = known[0].pos
  }

  const r = await reachKnownBlock(pos, b => STORAGE_TYPES.has(b.name) || FURNACES.includes(b.name), 'container', 15000)
  if (!r.block) {
    if (r.why !== 'aborted') { sendChat("Can't reach the container!"); recordFailure(`inspect - ${r.why}`) }
    state.currentTask = null
    return
  }
  const block = r.block

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
