// Building actions — place, build
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { sleep, isAborted } = require('../core/tick')
const { navigateTo, placeBlockAt } = require('../navigation/navigation')
const { removeBlock, trackPlacedBlock, createStructure, getStructures,
        logGameEvent } = require('../world/memory')
const { getInvMap, countMat } = require('../world/recipes')
const { offsets } = require('../config/constants')
const { WATER_BLOCKS, STRUCTURAL_AIR } = require('../config/blocks')
const { sendChat, normalizeItemName, recordFailure, fuzzyMatch, clearQueuedActions } = require('../core/utils')

async function doPlace(targetName) {
  const bot = state.bot
  state.currentTask = `placing ${targetName}`
  const normalized = normalizeItemName(targetName)
  const item = bot.inventory.items().find(i => fuzzyMatch(i.name, normalized))
  if (!item) {
    sendChat(`Don't have ${targetName}!`)
    console.log(`  no ${targetName} in inventory, skipping place`)
    const before = state.actionQueue.length
    clearQueuedActions('place:' + normalized)
    if (state.actionQueue.length < before) console.log(`  cleared ${before - state.actionQueue.length} place(s)`)
    state.currentTask = null
    return false
  }

  try {
    const placeableItems = ['boat', 'minecart']
    if (placeableItems.some(w => item.name.includes(w))) {
      await bot.equip(item, 'hand')

      if (item.name.includes('boat')) {
        // Boats can be placed on ANY block — land, ice, or water (not just open
        // water). Pick a surface block to place ON (the boat spawns on its top
        // face): prefer an adjacent water block for a directly-sailable boat,
        // otherwise drop it on the solid ground right where we're standing.
        const feet = bot.entity.position.floored()
        // Neighbors first (boat sits beside us, not inside us); under-feet last.
        const offs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1],[0,0]]
        let waterRef = null, groundRef = null
        for (const [dx, dz] of offs) {
          const surf = bot.blockAt(feet.offset(dx, -1, dz)) // block under foot level
          if (!surf) continue
          const above = bot.blockAt(surf.position.offset(0, 1, 0))
          const clear = above && (above.name === 'air' || WATER_BLOCKS.has(above.name))
          if (!clear) continue
          if (WATER_BLOCKS.has(surf.name)) { if (!waterRef) waterRef = surf }
          else if (surf.boundingBox === 'block') { if (!groundRef) groundRef = surf }
        }
        const refBlock = waterRef || groundRef

        if (!refBlock) {
          sendChat("No spot to place the boat!")
          console.log('  boat: no clear surface adjacent to place on')
          recordFailure('place:boat - no clear surface adjacent (need air/water above a block next to me)')
          return false
        }
        const surfPos = refBlock.position
        console.log(`  boat: placing on ${refBlock.name} at (${surfPos.x},${surfPos.y},${surfPos.z}) (${waterRef ? 'water' : 'land'})`)

        // Trigger placement with a raw use_item packet. A boat is NOT a block
        // item, so vanilla places it via ServerboundUseItem (the server raycasts
        // from the player's rotation), not block_place. We can't use mineflayer's
        // bot.placeEntity() / bot.activateItem() here: on 1.21.x both send a
        // use_item without the `rotation` field that the 1.21 packet requires,
        // which throws a serialization error and gets the bot kicked
        // (disconnect.timeout). Same raw-packet approach as doFill.
        let spawned = null
        for (let attempt = 0; attempt < 3; attempt++) {
          // Re-equip in case the held item changed between attempts
          const held = bot.heldItem
          if (!held || !held.name.includes('boat')) {
            const b2 = bot.inventory.items().find(i => fuzzyMatch(i.name, normalized))
            if (!b2) break
            await bot.equip(b2, 'hand')
            await sleep(200)
          }

          // Look at the top face of the chosen surface so the server's raycast
          // (which uses the rotation in this packet) lands on it.
          await bot.lookAt(surfPos.offset(0.5, 1, 0.5))
          await sleep(200)

          // The use_item rotation is the player rotation in *Notchian degrees*,
          // not mineflayer's radians. Same conversion mineflayer uses for the
          // look packet: yaw = deg(PI - yaw), pitch = deg(-pitch).
          const toDeg = r => r * 180 / Math.PI
          const notchYaw = toDeg(Math.PI - bot.entity.yaw)
          const notchPitch = toDeg(-bot.entity.pitch)

          const aiming = bot.blockAtCursor(5)
          console.log(`  boat: aim yaw=${notchYaw.toFixed(1)} pitch=${notchPitch.toFixed(1)} cursor=${aiming ? `${aiming.name}@(${aiming.position.x},${aiming.position.y},${aiming.position.z}) face=${aiming.face}` : 'none'}`)

          bot._client.write('use_item', {
            hand: 0,
            sequence: 0,
            rotation: { x: notchYaw, y: notchPitch }
          })
          await sleep(800)

          spawned = Object.values(bot.entities).find(e =>
            e !== bot.entity && e.name?.includes('boat') && e.position.distanceTo(surfPos) < 6
          )
          if (spawned) break
          // Also treat item-consumed as success (entity may be out of range)
          if (!bot.inventory.items().some(i => i.name === item.name)) break
          console.log(`  boat use_item attempt ${attempt + 1} didn't spawn, retrying...`)
          await sleep(300)
        }

        if (spawned) {
          console.log(`  placed ${item.name} at (${Math.round(spawned.position.x)},${Math.round(spawned.position.y)},${Math.round(spawned.position.z)}) (verified: ${spawned.name})`)
          sendChat(`${item.name} placed!`)
          state.consecutivePlaceFails = 0
          return true
        }
        const stillHas = bot.inventory.items().some(i => i.name === item.name)
        if (!stillHas) {
          console.log(`  placed ${item.name} (item consumed from inv, entity not detected)`)
          sendChat(`${item.name} placed!`)
          state.consecutivePlaceFails = 0
          return true
        }
        console.log(`  boat place FAILED — still in inventory, no entity spawned`)
        sendChat("Couldn't place the boat here!")
        state.consecutivePlaceFails++
        recordFailure('place:boat - boat did not spawn (spot may be obstructed; move to clearer ground or water and retry)')
        return false
      }

      // Non-boat placeables (minecart etc.)
      let target = null
      const botPos = bot.entity.position.floored()
      target = bot.blockAt(botPos.offset(0, -1, 0))
      if (!target || target.name === 'air') {
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const b = bot.blockAt(botPos.offset(dx, -1, dz))
          if (b && !STRUCTURAL_AIR.has(b.name) && !WATER_BLOCKS.has(b.name)) { target = b; break }
        }
      }
      if (!target) { sendChat("No surface to place on!"); return false }
      await bot.lookAt(target.position.offset(0.5, 1, 0.5))
      await bot.activateItem()
      await sleep(500)
      const spawned = Object.values(bot.entities).find(e =>
        e !== bot.entity && e.name?.includes(normalized) && e.position.distanceTo(target.position) < 5
      )
      if (spawned) {
        console.log(`  placed ${item.name} at ${target.position} (verified: entity ${spawned.name})`)
      } else {
        console.log(`  placed ${item.name} at ${target.position} (warning: could not verify entity spawn)`)
      }
      sendChat(`${item.name} placed!`)
      state.consecutivePlaceFails = 0
      return true
    }

    await bot.equip(item, 'hand')
    const botPos = bot.entity.position.floored()

    // Helper: check if an entity (bot or other players/mobs) occupies a block position
    // Entities have ~0.6 wide hitboxes and ~1.8 tall, so they occupy 2 vertical blocks
    function isEntityBlocking(pos) {
      for (const entity of Object.values(bot.entities)) {
        if (!entity.position) continue
        const ep = entity.position
        const dx = Math.abs(ep.x - (pos.x + 0.5))
        const dz = Math.abs(ep.z - (pos.z + 0.5))
        if (dx >= 0.8 || dz >= 0.8) continue  // too far horizontally
        // Entity occupies from ep.y to ep.y + height (1.8 for players, varies for mobs)
        const height = entity.height || 1.8
        if (pos.y >= ep.y + height || pos.y + 1 <= ep.y) continue  // no vertical overlap
        return true
      }
      return false
    }

    for (const [dx,dy,dz] of offsets) {
      const airPos = botPos.offset(dx, dy, dz)
      const airBlock = bot.blockAt(airPos)
      if (!airBlock || airBlock.name !== 'air') continue
      if (bot.entity.position.distanceTo(airPos) > 5) continue
      if (isEntityBlocking(airPos)) continue  // skip positions occupied by entities

      // placeBlockAt verifies the exact block landed (not just "something solid")
      const placedName = await placeBlockAt(item, airPos)
      if (placedName) {
        console.log(`  placed ${item.name} at ${airPos} (verified: ${placedName})`)
        trackPlacedBlock(airPos.x, airPos.y, airPos.z)
        logGameEvent('place', placedName, 1, airPos.x, airPos.y, airPos.z, { reason: 'place_action' })
        // Utility blocks are tracked via the blocks table (vision stores them)
        sendChat('Placed!')
        state.consecutivePlaceFails = 0
        return true
      }
    }
    // No air spot found — try digging out a nearby solid block to create space
    const { digBlock } = require('../navigation/navigation')
    const digCandidates = [
      [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
      [1,0,1],[-1,0,-1],[1,0,-1],[-1,0,1],
      [0,1,0],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1],
    ]
    let dugSpot = false
    for (const [dx,dy,dz] of digCandidates) {
      const digPos = botPos.offset(dx, dy, dz)
      if (isEntityBlocking(digPos)) continue
      const block = bot.blockAt(digPos)
      if (!block || block.name === 'air' || !block.diggable) continue
      // Don't dig out blocks we're standing on
      if (dy === -1) continue
      console.log(`  place: no air spots, digging ${block.name} at ${digPos} to make room`)
      const dug = await digBlock(digPos)
      if (dug) {
        // Now try placing at the newly cleared spot
        const placedName = await placeBlockAt(item, digPos)
        if (placedName) {
          console.log(`  placed ${item.name} at ${digPos} (verified: ${placedName}) [dug space]`)
          trackPlacedBlock(digPos.x, digPos.y, digPos.z)
          logGameEvent('place', placedName, 1, digPos.x, digPos.y, digPos.z, { reason: 'place_action' })
          // Utility blocks are tracked via the blocks table (vision stores them)
          sendChat('Placed!')
          state.consecutivePlaceFails = 0
          return true
        }
        dugSpot = true
        break  // only dig one block
      }
    }

    state.consecutivePlaceFails++
    if (state.consecutivePlaceFails <= 1) sendChat("Couldn't place here — no valid spot!")
    console.log(`  place ${item.name} FAILED — no valid placement spot (attempt #${state.consecutivePlaceFails})${dugSpot ? ' [dug space but place still failed]' : ''}`)
    recordFailure(`place:${item.name} - no valid spot`)
  } catch (err) {
    console.error('  place err:', err.message)
  }
  // Reaching here means no success path returned true → the placement failed.
  state.currentTask = null
  return false
}

async function doBuild() {
  const { stopAll } = require('../core/tick')
  stopAll()
  const bot = state.bot
  state.currentTask = 'building'

  if (!state.pendingBlueprint) {
    sendChat('No blueprint designed yet! Design one first with [BLUEPRINT:...]')
    console.log('  build: no pending blueprint')
    state.currentTask = null
    return false
  }

  const bp = state.pendingBlueprint
  state.pendingBlueprint = null

  // Determine origin: reuse existing structure origin if resuming, else 2 blocks ahead
  let origin
  let structureId
  let structureName
  const structures = getStructures()
  const topGoal = state.taskStack.length > 0 ? state.taskStack[state.taskStack.length - 1].t : null
  const existing = structures.find(s => s.blueprint && s.block_count > 0)
  if (existing) {
    origin = new Vec3(existing.x1, existing.y1, existing.z1)
    structureId = existing.id
    structureName = existing.name
    console.log(`  build: RESUMING structure "${structureName}" at ${origin.x},${origin.y},${origin.z} (${existing.block_count} blocks placed)`)
  } else {
    const yaw = bot.entity.yaw
    const fwd = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
    origin = bot.entity.position.floored().plus(fwd.scaled(2).floored())
    structureName = topGoal || 'unnamed build'
    structureId = createStructure(structureName, bp.raw || null, origin.x, origin.y, origin.z)
    console.log(`  build: NEW structure "${structureName}" at ${origin.x},${origin.y},${origin.z}`)
  }

  const sorted = [...bp.blocks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  const replaceable = new Set(['air', 'short_grass', 'tall_grass', 'water', 'cave_air'])

  // --- PRE-BUILD SPACE CHECK ---
  const obstructions = []
  const clearable = []
  for (const b of sorted) {
    const placePos = origin.offset(b.x, b.y, b.z)
    const ex = bot.blockAt(placePos)
    if (ex && !replaceable.has(ex.name)) {
      if (ex.name === b.block) continue
      if (ex.diggable) {
        clearable.push({ pos: placePos, block: ex, target: b })
      } else {
        obstructions.push({ pos: placePos, name: ex.name, target: b.block })
      }
    }
  }

  if (obstructions.length > 0 || clearable.length > 0) {
    console.log(`  build: SPACE CHECK — ${clearable.length} clearable, ${obstructions.length} unbreakable obstructions`)
    for (const o of obstructions.slice(0, 10)) {
      console.log(`    BLOCKED: (${o.pos.x},${o.pos.y},${o.pos.z}) has ${o.name}, need ${o.target}`)
    }
  }

  if (obstructions.length > 0) {
    const msg = `Can't build: ${obstructions.length} unbreakable blocks in the way (e.g. ${obstructions[0].name} at ${obstructions[0].pos.x},${obstructions[0].pos.y},${obstructions[0].pos.z})`
    sendChat(msg)
    recordFailure(`build - ${msg}`)
    state.pendingBlueprint = bp
    state.currentTask = null
    return false
  }

  // Clear breakable obstructions
  if (clearable.length > 0) {
    console.log(`  build: clearing ${clearable.length} obstructions...`)
    sendChat(`Clearing ${clearable.length} blocks from build area...`)
    for (const c of clearable) {
      if (isAborted()) { state.currentTask = null; return false }
      const dist = bot.entity.position.distanceTo(c.pos)
      if (dist > 4) await navigateTo(c.pos.x, c.pos.y, c.pos.z, 3, 8000)
      try {
        await bot.tool.equipForBlock(c.block).catch(() => {})
        await bot.dig(c.block)
        removeBlock(c.pos.x, c.pos.y, c.pos.z)
        logGameEvent('mine', c.block.name, 1, c.pos.x, c.pos.y, c.pos.z, { reason: 'build_clear' })
        console.log(`    cleared ${c.block.name} at (${c.pos.x},${c.pos.y},${c.pos.z})`)
      } catch (e) {
        console.log(`    failed to clear ${c.block.name} at (${c.pos.x},${c.pos.y},${c.pos.z}): ${e.message}`)
      }
    }
    await sleep(300)
  }

  // Check which blocks are already placed (resume-aware)
  let alreadyPlaced = 0
  const needed = []
  for (const b of sorted) {
    const placePos = origin.offset(b.x, b.y, b.z)
    const ex = bot.blockAt(placePos)
    if (ex && !replaceable.has(ex.name)) {
      alreadyPlaced++
    } else {
      needed.push(b)
    }
  }

  if (alreadyPlaced > 0) {
    console.log(`  build: ${alreadyPlaced}/${sorted.length} already placed, ${needed.length} remaining`)
  }

  // Material check
  const needMats = {}
  for (const b of needed) needMats[b.block] = (needMats[b.block] || 0) + 1
  const invMap = getInvMap()
  const missing = []
  for (const [mat, count] of Object.entries(needMats)) {
    const have = countMat(mat, invMap)
    if (have < count) missing.push(`${mat}x${count - have}`)
  }
  if (missing.length > 0) {
    const needStr = Object.entries(needMats).map(([m, c]) => `${m}x${c}`).join(', ')
    const msg = `Need materials: ${missing.join(', ')} (total needed: ${needStr})`
    sendChat(msg)
    console.log(`  build: ${msg}`)
    recordFailure(`build - missing: ${missing.join(', ')}`)
    state.pendingBlueprint = bp
    state.currentTask = null
    return false
  }

  sendChat(`Building ${needed.length} blocks at ${origin.x},${origin.y},${origin.z}...`)
  console.log(`  build: placing ${needed.length} blocks (${alreadyPlaced} pre-existing), origin=(${origin.x},${origin.y},${origin.z})`)
  console.log(`  build: materials: ${Object.entries(needMats).map(([m,c]) => `${m}x${c}`).join(', ')}`)

  let placed = 0
  let skipped = 0
  const failedBlocks = []
  const autoOccupied = new Set()  // positions auto-filled by 2-tall blocks (door top halves)

  for (const b of needed) {
    if (isAborted()) { state.currentTask = null; return }

    const placePos = origin.offset(b.x, b.y, b.z)
    const posKey = `${placePos.x},${placePos.y},${placePos.z}`
    if (autoOccupied.has(posKey)) { skipped++; continue }
    const cur = bot.blockAt(placePos)
    if (cur && !replaceable.has(cur.name)) { skipped++; continue }

    const item = bot.inventory.items().find(i => i.name === b.block)
    if (!item) {
      const failMsg = `out of ${b.block} at offset(${b.x},${b.y},${b.z}) world(${placePos.x},${placePos.y},${placePos.z})`
      console.log(`  build: ${failMsg}`)
      sendChat(`Ran out of ${b.block}!`)
      recordFailure(`build - ${failMsg}`)
      state.currentTask = null
      return false
    }

    const dist = bot.entity.position.distanceTo(placePos)
    if (dist > 4) {
      await navigateTo(placePos.x, placePos.y, placePos.z, 3, 10000)
    }

    await bot.equip(item, 'hand')

    const buildFaces = [
      [0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]
    ]
    let ok = false
    for (const [fx, fy, fz] of buildFaces) {
      const refPos = placePos.offset(fx, fy, fz)
      const refBlock = bot.blockAt(refPos)
      if (refBlock && !STRUCTURAL_AIR.has(refBlock.name) && !WATER_BLOCKS.has(refBlock.name)) {
        try {
          await bot.placeBlock(refBlock, new Vec3(-fx, -fy, -fz))
          trackPlacedBlock(placePos.x, placePos.y, placePos.z, structureId, b.x, b.y, b.z)
          logGameEvent('place', b.block, 1, placePos.x, placePos.y, placePos.z, { reason: 'build', structure_id: structureId })
          placed++
          ok = true
          // Doors are 2-tall — mark the block above as auto-occupied
          if (b.block.includes('door')) {
            const abovePos = placePos.offset(0, 1, 0)
            autoOccupied.add(`${abovePos.x},${abovePos.y},${abovePos.z}`)
          }
          break
        } catch (e) {
          if (fz === -1) console.log(`  build: place failed at (${placePos.x},${placePos.y},${placePos.z}) ${b.block}: ${e.message}`)
        }
      }
    }
    if (!ok) {
      failedBlocks.push({ block: b.block, pos: placePos, offset: b })
      console.log(`  build: FAILED ${b.block} at (${placePos.x},${placePos.y},${placePos.z}) [offset ${b.x},${b.y},${b.z}] — no valid reference face`)
    }

    if ((placed + failedBlocks.length) % 10 === 0) {
      console.log(`  build: ${placed} placed, ${failedBlocks.length} failed, ${needed.length - placed - failedBlocks.length - skipped} remaining`)
    }
  }

  const failSummary = failedBlocks.length > 0
    ? ` Failed: ${failedBlocks.map(f => `${f.block}@(${f.pos.x},${f.pos.y},${f.pos.z})`).join(', ')}`
    : ''
  const totalPlaced = placed + alreadyPlaced
  sendChat(`Done! Placed ${placed} blocks (${totalPlaced}/${sorted.length} total)${failedBlocks.length > 0 ? `, ${failedBlocks.length} couldn't place` : ''}.`)
  console.log(`  build complete: ${placed} new + ${alreadyPlaced} existing = ${totalPlaced}/${sorted.length}, ${failedBlocks.length} failed, ${skipped} skipped`)
  if (failSummary) {
    console.log(`  build failures:${failSummary}`)
    recordFailure(`build - ${failedBlocks.length} blocks couldn't place: ${failedBlocks.map(f => `${f.block}@(${f.pos.x},${f.pos.y},${f.pos.z})`).slice(0, 5).join(', ')}`)
  }
  state.currentTask = null
  // Success if we placed something, or there was nothing left to place (already built).
  return placed > 0 || needed.length === 0
}

module.exports = { doPlace, doBuild }
