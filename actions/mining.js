// Mining actions — mine, collect
const { Vec3 } = require('vec3')
const state = require('../state')
const { tickWait, raceAbort, AbortError, stopAll, isAborted } = require('../tick')
const { navigateTo } = require('../navigation')
const { removeBlock, queryBlockMemory, logGameEvent } = require('../memory')
const { castVisionRays, hasLineOfSight } = require('../vision')
const { c, color } = require('../lib/colors')
const { sendChat, debugChat, normalizeItemName, recordFailure, fuzzyMatch, parseCoordTarget } = require('../utils')

async function doMine(targetName) {
  stopAll()
  const bot = state.bot
  const mcData = require('minecraft-data')(bot.version)

  // Support mine:block_name:x,y,z format for explicit coordinates
  // Support mine:block_name:COUNT for batch mining
  let explicitPos = null
  let rawName = targetName
  let batchCount = 1
  const coord = parseCoordTarget(targetName)
  const countMatch = targetName.match(/^(.+?):(\d+)$/)
  if (coord) {
    rawName = coord.name
    explicitPos = new Vec3(coord.x, coord.y, coord.z)
  } else if (countMatch && !countMatch[1].includes(',')) {
    rawName = countMatch[1]
    batchCount = Math.min(parseInt(countMatch[2]), 256)
  }

  const normalized = normalizeItemName(rawName)
  state.currentTask = `mining ${rawName}${batchCount > 1 ? ' x' + batchCount : ''}`

  let blockType = mcData.blocksByName[normalized]
  let matchingIds = []
  if (blockType) {
    matchingIds = [blockType.id]
  } else {
    let matches = Object.keys(mcData.blocksByName).filter(n => {
      const parts = n.split('_')
      if (parts.includes(normalized)) return true
      if (normalized.includes(n)) return true
      return false
    })
    if (matches.length === 0) {
      matches = Object.keys(mcData.blocksByName).filter(n => fuzzyMatch(n, normalized))
    }
    if (matches.length === 0) { sendChat(`Don't know what ${targetName} is!`); state.currentTask = null; return false }
    blockType = mcData.blocksByName[matches[0]]
    matchingIds = matches.map(n => mcData.blocksByName[n].id)
  }

  const isWood = normalized.includes('log') || normalized.includes('wood') || normalized.includes('stem')
  let mined = 0

  for (let batch = 0; batch < batchCount; batch++) {
  if (isAborted()) break
  if (batch > 0) state.currentTask = `mining ${rawName} (${mined}/${batchCount})`

  const vision = castVisionRays(16, 256, 'reach')
  const visionCandidates = []
  if (vision?.seenBlocks) {
    const matchingNames = new Set(matchingIds.map(id => mcData.blocks[id]?.name).filter(Boolean))
    for (const [name, positions] of Object.entries(vision.seenBlocks)) {
      if (matchingNames.has(name)) {
        for (const p of positions) {
          const key = `${p.x},${p.y},${p.z}`
          if (!state.skipBlocks.has(key)) visionCandidates.push(new Vec3(p.x, p.y, p.z))
        }
      }
    }
  }

  const seenKeys = new Set()
  const candidates = []

  // If explicit coordinates given, verify and use as first candidate
  if (explicitPos) {
    const eb = bot.blockAt(explicitPos)
    if (eb && matchingIds.includes(eb.type)) {
      const key = `${explicitPos.x},${explicitPos.y},${explicitPos.z}`
      if (!state.skipBlocks.has(key)) {
        seenKeys.add(key)
        candidates.push(explicitPos)
        console.log(`  using explicit coords (${explicitPos.x},${explicitPos.y},${explicitPos.z})`)
      }
    } else {
      console.log(`  explicit coords (${explicitPos.x},${explicitPos.y},${explicitPos.z}) — block not found or wrong type`)
    }
  }

  for (const pos of visionCandidates) {
    const key = `${pos.x},${pos.y},${pos.z}`
    if (!seenKeys.has(key) && !state.stmts.isPlaced.get(pos.x, pos.y, pos.z)) {
      seenKeys.add(key); candidates.push(pos)
    }
  }

  if (candidates.length === 0) {
    const matchingNames = new Set(matchingIds.map(id => mcData.blocks[id]?.name).filter(Boolean))
    const remembered = queryBlockMemory(matchingNames, bot.entity.position)
    const eyePos = bot.entity.position.offset(0, 1.62, 0)
    for (const best of remembered) {
      const key = `${best.x},${best.y},${best.z}`
      if (state.skipBlocks.has(key) || state.stmts.isPlaced.get(best.x, best.y, best.z)) continue
      const blockPos = new Vec3(best.x, best.y, best.z)
      if (!hasLineOfSight(eyePos, blockPos.offset(0.5, 0.5, 0), 1)) continue
      console.log(`  ${targetName} not in vision, but remembered ${best.name} at (${best.x},${best.y},${best.z}) ${Math.round(best.dist)}m away (${Math.round(best.age)}s ago)`)
      candidates.push(blockPos)
      break
    }
  }

  if (candidates.length === 0) {
    if (state.skipBlocks.size > 500) state.skipBlocks.clear()
    console.log(color(c.yellow, `  ${targetName} not visible or remembered`))
    recordFailure(`mine:${targetName} - can't see any nearby. Use [ACTION:goto:X,Y,Z] to move to a new area first.`)
    break // no candidates, stop batch
  }

  let block
  if (isWood) {
    const botY = bot.entity.position.y
    let bestScore = Infinity
    for (const pos of candidates) {
      const b = bot.blockAt(pos)
      if (!b) continue
      let groundDist = 0
      for (let dy = 1; dy <= 5; dy++) {
        const below = bot.blockAt(pos.offset(0, -dy, 0))
        if (below && below.name !== 'air' && !below.name.includes('leaves') && !below.name.includes('log')) {
          groundDist = dy; break
        }
      }
      if (groundDist === 0) groundDist = 10
      const dist = bot.entity.position.distanceTo(pos)
      const yPenalty = Math.max(0, pos.y - botY - 3) * 4
      const score = dist + yPenalty + groundDist * 3
      if (score < bestScore) { bestScore = score; block = b }
    }
    if (!block) block = bot.blockAt(candidates[0])
  } else {
    block = bot.blockAt(candidates[0])
  }

  const bPos = block.position
  const dist = Math.round(bot.entity.position.distanceTo(bPos))
  // Describe relative direction for chat
  const relX = bPos.x - Math.floor(bot.entity.position.x)
  const relY = bPos.y - Math.floor(bot.entity.position.y)
  const relZ = bPos.z - Math.floor(bot.entity.position.z)
  const dirs = []
  if (relY > 0) dirs.push(`${relY}up`)
  else if (relY < 0) dirs.push(`${-relY}down`)
  if (relZ < 0) dirs.push('N')
  else if (relZ > 0) dirs.push('S')
  if (relX > 0) dirs.push('E')
  else if (relX < 0) dirs.push('W')
  const dirStr = dirs.length > 0 ? dirs.join('') : 'here'
  debugChat(`[mine] ${block.name} @${bPos.x},${bPos.y},${bPos.z} (${dirStr} ${dist}m)`)
  console.log(`\n  found ${blockType.name} at (${bPos.x},${bPos.y},${bPos.z}) dist=${dist}`)

  // Simple navigation: pathfinder only. If it fails, report and let AI decide.
  const reached = await navigateTo(bPos.x, bPos.y, bPos.z, 4, 15000)
  if (isAborted()) break
  if (!reached) {
    const newDist = Math.round(bot.entity.position.distanceTo(bPos))
    console.log(`  can't reach ${blockType.name} at (${bPos.x},${bPos.y},${bPos.z}), ${newDist}m away`)
    recordFailure(`mine:${targetName} - can't reach (${bPos.x},${bPos.y},${bPos.z}), ${newDist}m away. Use [ACTION:goto:${bPos.x},${bPos.y},${bPos.z}] to get closer first.`)
    break
  }

  try {
    const target = bot.blockAt(bPos)
    if (target && bot.canDigBlock(target)) {
      if (target.harvestTools) {
        try {
          await bot.tool.equipForBlock(target, { requireHarvest: true })
        } catch (e) {
          if (!target.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
            const validTools = Object.keys(target.harvestTools).map(id => mcData.items[id]?.name).filter(Boolean)
            console.log(`  warning: mining ${target.name} without proper tool (need: ${validTools.join(', ')})`)
          }
        }
      } else {
        try { await bot.tool.equipForBlock(target) } catch (e) { console.warn('  [MINE] equip err:', e.message) }
      }
      await raceAbort(bot.dig(target), 30000)
      const check = bot.blockAt(bPos)
      if (check && check.name === target.name) {
        console.log(`  dig completed but ${target.name} still there, skipping`)
        state.skipBlocks.add(`${bPos.x},${bPos.y},${bPos.z}`)
        recordFailure(`mine:${targetName} - block at ${bPos.x},${bPos.y},${bPos.z} unbreakable (wrong tool?)`)
      } else {
        removeBlock(bPos.x, bPos.y, bPos.z)
        mined++
        logGameEvent('mine', target.name, 1, bPos.x, bPos.y, bPos.z, { tool: bot.heldItem?.name || 'hand', reason: 'mine_action' })
        console.log(color(c.green, `\n  mined ${target.name}${batchCount > 1 ? ` (${mined}/${batchCount})` : ''}`))
        try { await tickWait(400) } catch(e) {}
        if (!isAborted()) {
          const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bPos) < 5)
          if (drop) {
            await navigateTo(drop.position.x, drop.position.y, drop.position.z, 1, 3000, { noReachCheck: true })
            console.log('  collected drop')
          }
        }
      }
    } else {
      console.log(`  can't dig ${target?.name || 'null'}`)
      state.skipBlocks.add(`${bPos.x},${bPos.y},${bPos.z}`)
    }
  } catch (err) {
    if (err instanceof AbortError) throw err
    if (err.message === 'timeout') {
      console.log(`  dig timed out on block at ${bPos}`)
      state.skipBlocks.add(`${bPos.x},${bPos.y},${bPos.z}`)
      try { bot.stopDigging() } catch(e) {}
    } else {
      console.error('  dig err:', err.message)
    }
  }
  } // end batch loop

  if (batchCount > 1) console.log(color(c.green, `  mining done: ${mined}/${batchCount} ${rawName}`))
  state.currentTask = null
  // Success only if at least one block was actually mined. Zero (couldn't see/reach the
  // target, or an entity/unknown name like `oak_boat`) is a real failure, not a "done".
  return mined > 0
}

async function doCollect() {
  stopAll()
  const bot = state.bot
  state.currentTask = 'collecting'
  const isDroppedItem = (e) => e.name === 'item' || e.name === 'Item' || e.name === 'item_stack' ||
    e.entityType === 2 || (e.displayName && e.displayName.toLowerCase().includes('item'))
  const items = Object.values(bot.entities).filter(e =>
    isDroppedItem(e) && e.position.distanceTo(bot.entity.position) < 32
  ).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  if (items.length === 0) {
    const nearEnts = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 32)
      .map(e => `${e.name}(${e.entityType})`)
    if (nearEnts.length > 0) console.log(`  no items found, nearby entities: ${nearEnts.slice(0, 10).join(', ')}`)
  }
  console.log(`  ${items.length} items nearby`)
  for (const item of items) {
    if (isAborted() || !item.isValid) continue
    try {
      await navigateTo(item.position.x, item.position.y, item.position.z, 1, 8000, { noReachCheck: true })
      try { await tickWait(300) } catch(e) { break }
    } catch (e) {
      if (e instanceof AbortError) throw e
    }
  }
  state.currentTask = null
}

module.exports = { doMine, doCollect }
