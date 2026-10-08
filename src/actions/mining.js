// Mining actions — mine, collect
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { tickWait, raceAbort, AbortError, stopAll, isAborted } = require('../core/tick')
const { navigateTo, digBlock } = require('../navigation/navigation')
const { removeBlock, queryBlockMemory, logGameEvent } = require('../world/memory')
const { castVisionRays, hasLineOfSight } = require('../perception/vision')
const { approachToTouch, touchFailText } = require('../perception/touch')
const { c, color } = require('../lib/colors')
const { sendChat, debugChat, logEvent, normalizeItemName, recordFailure, fuzzyMatch, parseCoordTarget } = require('../core/utils')
const { labelOf } = require('../world/blockLabel')

async function doMine(targetName, opts = {}) {
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
    if (matches.length === 0) { sendChat(`Don't know what ${targetName} is!`); recordFailure(`mine:${targetName} - no such block`); state.currentTask = null; return false }
    blockType = mcData.blocksByName[matches[0]]
    matchingIds = matches.map(n => mcData.blocksByName[n].id)
  }

  let mined = 0
  let speedWarned = false  // harvest speed advisory fires at most once per mine action

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

  // Explicit coordinates name exactly one block: mine that one or fail, never a substitute
  // (the wood scoring below would otherwise prefer another log of the same tree).
  if (explicitPos) {
    const at = `${explicitPos.x},${explicitPos.y},${explicitPos.z}`
    const eb = bot.blockAt(explicitPos)
    if (!eb || !matchingIds.includes(eb.type) || state.skipBlocks.has(at)) {
      console.log(`  explicit coords (${at}) — block not found, wrong type or skipped`)
      recordFailure(`mine:${targetName} - no ${rawName} at ${at} (${eb ? labelOf(eb) : 'unloaded'}). Mine by name without coords, or pick coords from VISION.`)
      break
    }
    console.log(`  using explicit coords (${at})`)
    candidates.push(explicitPos)
  }

  for (const pos of explicitPos ? [] : visionCandidates) {
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

  // Nearest first: vision lists blocks in ray order, not by distance.
  const here = bot.entity.position
  const nearest = candidates.reduce((a, b) => (here.distanceTo(b) < here.distanceTo(a) ? b : a))
  const block = bot.blockAt(nearest)

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

  // Walk up to it; dig only when it is in reach and in sight. Being out of reach says
  // nothing about the block itself, so it is reported, never blacklisted.
  const touch = await approachToTouch(bPos, 15000)
  if (!touch || isAborted()) break
  if (!touch.ok) {
    const why = touchFailText(block.name, bPos, touch)
    console.log(`  can't mine: ${why}`)
    recordFailure(`mine:${targetName} - ${why}. Use [ACTION:goto:${bPos.x},${bPos.y},${bPos.z}] to get closer first.`)
    break
  }

  try {
    const target = bot.blockAt(bPos)
    if (target && target.diggable) {
      // The dig itself goes through the atomic. Intent 'harvest' equips a
      // drop-capable tool and REFUSES a block that would drop nothing without one
      // — unless the AI escalated with :skiptool (→ clear-no-tool, hand-mine it).
      // The AI explicitly targeted THIS block, so we honour its exact spot:
      // ignore path/blueprint protection and mine even next to hazards (ore beside
      // lava is common). The atomic handles equip, break-verify, DB + event log.
      const intent = opts.skipTool ? 'clear-no-tool' : 'harvest'
      const res = await digBlock(bPos, { intent, reason: 'mine_action',
        ignorePathBlocks: true, ignorePlacedBlocks: true, allowHazards: true })
      // digBlock swallows AbortError (nav's "never throw on abort" contract), so a
      // mid-dig stop returns {ok:false}. Break cleanly instead of logging a failure.
      if (isAborted()) break
      if (res.ok) {
        mined++
        console.log(color(c.green, `\n  mined ${target.name}${batchCount > 1 ? ` (${mined}/${batchCount})` : ''}`))
        // Harvest succeeded by hand, but a tool would be much faster — note it once
        // (NEW=, not a failure) so the AI can choose to craft one for the batch.
        if (res.warn && !speedWarned) {
          speedWarned = true
          const { tool, factor } = res.warn
          console.log(color(c.yellow, `  hand-mining ${target.name} — a ${tool} would be ~${factor}x faster`))
          logEvent(`hand-mining ${rawName} without a ${tool} (~${factor}x slower than with one) — craft a ${tool} to speed up this batch`)
        }
        try { await tickWait(400) } catch(e) {}
        if (!isAborted()) {
          const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bPos) < 5)
          if (drop) {
            await navigateTo(drop.position.x, drop.position.y, drop.position.z, 1, 3000, { noReachCheck: true })
            console.log('  collected drop')
          }
        }
      } else if (res.reason === 'need_tool') {
        console.log(color(c.yellow, `  refusing to hand-mine ${target.name} — no ${res.need} (would drop nothing)`))
        recordFailure(`mine:${targetName} - ${labelOf(target)} needs a ${res.need} to drop anything (mining by hand yields nothing). Craft/equip a ${res.need}, or re-issue [ACTION:mine:${rawName}:skiptool] to break it for no drop.`)
        break
      } else {
        console.log(`  dig failed on ${target.name} (${res.reason})`)
        // Only a block that can't be broken at all is skipped from now on; a refusal
        // (not permitted yet, hazard next to it, protected path block) may change.
        if (res.reason === 'unbreakable' || res.reason === 'not_diggable') state.skipBlocks.add(`${bPos.x},${bPos.y},${bPos.z}`)
        recordFailure(`mine:${targetName} - block at ${bPos.x},${bPos.y},${bPos.z} ${res.reason === 'unbreakable' ? 'unbreakable (wrong tool?)' : `could not be dug (${res.reason})`}`)
      }
    } else {
      console.log(`  can't dig ${target?.name || 'null'}`)
      state.skipBlocks.add(`${bPos.x},${bPos.y},${bPos.z}`)
      recordFailure(`mine:${targetName} - ${target ? `${labelOf(target)} at ${bPos.x},${bPos.y},${bPos.z} can't be dug` : `block at ${bPos.x},${bPos.y},${bPos.z} is unloaded`}`)
    }
  } catch (err) {
    if (err instanceof AbortError) throw err
    if (err.message === 'timeout') {
      console.log(`  dig timed out on block at ${bPos}`)
      recordFailure(`mine:${targetName} - digging the block at ${bPos.x},${bPos.y},${bPos.z} timed out`)
      state.skipBlocks.add(`${bPos.x},${bPos.y},${bPos.z}`)
      try { bot.stopDigging() } catch(e) {}
    } else {
      console.error('  dig err:', err.message)
      recordFailure(`mine:${targetName} - ${err.message}`)
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
