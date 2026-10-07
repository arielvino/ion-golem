// Bot context builder — assembles real-time state snapshot for AI prompts
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { getLastVisionResult, formatVision, hasLineOfSight } = require('../perception/vision')
const { getLastSurvey } = require('../perception/visibility')
const { recognizeView, formatPlacesContext } = require('../perception/recognize')
const { lookAround } = require('../perception/sight')
const { summarizeSight, formatSight } = require('../perception/sightSummary')
const ranges = require('../config/ranges')
const { SEARCH_UTILITY, SEARCH_FAR } = require('../config/search')
const { currentDim, getStructures, getNearbyContainers, getContainerState, countNearbyPathBlocks, queryUtilityBlocks } = require('../world/memory')
const { renderAgenda } = require('../engine/tasks')
const { renderNew, renderNotesBlock } = require('../world/journalStore')
const { ago } = require('../world/journal')
const { getBackgroundSummary } = require('../engine/backgroundTask')
const { getInvMap, countMat } = require('../world/recipes')
const { providerNames, renderPending, around } = require('./ctxProviders')
const { snapshot, renderDelta } = require('./delta')
const { entityTag } = require('../perception/entityTag')
const { entityClass } = require('../perception/entityClass')

// Item name with remaining durability for damageable items: iron_pickaxe(212/250).
// Stackables keep the xN count instead (withCount).
function itemLabel(item, withCount = false) {
  if (!item) return 'nothing'
  if (item.maxDurability) return `${item.name}(${item.maxDurability - (item.durabilityUsed || 0)}/${item.maxDurability})`
  return withCount ? `${item.name}x${item.count}` : item.name
}

// --- Main context builder ---
function getBotContext() {
  const bot = state.bot
  const pos = bot.entity.position
  // DELTA compares bare names; durability only goes in the rendered blob, so
  // every swing doesn't read as a held/armor change.
  const held = bot.heldItem ? bot.heldItem.name : 'nothing'
  const offhand = bot.inventory.slots[45]?.name || 'nothing'
  const inv = bot.inventory.items().map(i => itemLabel(i, true)).join(', ') || 'empty'
  const armorItems = [
    bot.inventory.slots[5], bot.inventory.slots[6],
    bot.inventory.slots[7], bot.inventory.slots[8]
  ].filter(Boolean)
  const armorSlots = armorItems.map(s => s.name)
  const armorStr = armorItems.length > 0 ? ` armor=[${armorItems.map(s => itemLabel(s)).join(',')}]` : ' armor=none'
  const eyePos = pos.offset(0, 1.62, 0)
  const nearbyNames = []
  const drops = {}  // drop tag → stack size, so DELTA can report a pile growing
  const playerDist = {}  // tracked player → distance; staying in view isn't staying put
  // Equipment for players and armed mobs (zombies, skeletons, piglins, etc.)
  const equipOf = (e) => {
    const parts = []
    if (e.equipment) {
      const labels = ['hand', 'off', 'head', 'chest', 'legs', 'feet']
      for (let i = 0; i < labels.length; i++) {
        const item = e.equipment[i]
        if (item && item.name) parts.push(`${labels[i]}:${item.name}`)
      }
    }
    return parts.length > 0 ? `,${parts.join(',')}` : ''
  }
  // Every visible non-player entity, nearest first. Players have PLAYERS= below.
  // Background mobs (fish, squid, bats) are summarized per type after the tagged
  // list; drops only show within pickup range.
  const background = {}  // name → { n, near }
  const nearby = Object.values(bot.entities)
    .filter(e => e !== bot.entity && !e.username && e.position.distanceTo(pos) < ranges.sight.nearbyEntities)
    .filter(e => hasLineOfSight(eyePos, e.position, e.height || 1.8))
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    .filter(e => {
      const kind = entityClass(e)
      if (kind === 'drop') return e.position.distanceTo(pos) < ranges.sight.nearbyDrops
      if (kind !== 'background') return true
      const b = background[e.name] || (background[e.name] = { n: 0, near: Math.round(e.position.distanceTo(pos)) })
      b.n++
      return false
    })
    .map(e => {
      const tag = entityTag(e)
      const ep = e.position
      const coord = `@${Math.round(ep.x)},${Math.round(ep.y)},${Math.round(ep.z)}`
      const dist = `${Math.round(ep.distanceTo(pos))}m`
      let count = ''
      if (tag.startsWith('drop:')) {
        try { drops[tag] = e.getDroppedItem().count; count = `,x${drops[tag]}` } catch (_) { /* no drop data */ }
      }
      nearbyNames.push(tag)
      return `${tag}${coord}(${dist}${count}${equipOf(e)})`
    })
    .concat(Object.entries(background).map(([name, b]) => {
      nearbyNames.push(name)
      return `${name}×${b.n}(${b.near}m+)`
    }))
    .join(', ') || 'none'
  // Facing direction from yaw. yawToDir maps any mineflayer yaw (radians) to a
  // compass label; also reused for locator bearings toward out-of-range players.
  const facingDirs = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE']
  const yawToDir = (y) => facingDirs[Math.round(((((y + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8]
  const facing = yawToDir(bot.entity.yaw)
  const t = bot.time.timeOfDay
  // MC ticks: 0=6:00, 6000=12:00, 12000=18:00, 18000=0:00
  const hours = Math.floor(((t + 6000) % 24000) / 1000)
  const time = `${hours}:00(${t}t)`
  const onlineStr = state.joinedAt ? ` online=${ago(Date.now() - state.joinedAt)}` : ''
  // Sky exposure: skyLight=0 means enclosed/underground. Mob spawning at night or underground.
  let lightStr = ''
  try {
    const footBlock = bot.blockAt(pos)
    if (footBlock) {
      const sl = footBlock.skyLight
      const nightTime = t >= 13000 && t < 23000
      // skyLight=0 means enclosed from above. But under trees skyLight=0 too.
      // Cross-check with vision skyVisible — if vision sees sky, we're not underground.
      const visionResult = getLastVisionResult()
      const underground = sl === 0 && (!visionResult || !visionResult.skyVisible)
      lightStr = underground ? ' underground' : ''
      // Nothing hostile spawns on peaceful, so the warning would only be noise there.
      if ((underground || nightTime) && bot.game.difficulty !== 'peaceful') lightStr += '(mobs_spawn!)'
    }
  } catch(e) { console.warn('  [CTX] light detection err:', e.message) }
  const bgInfo = getBackgroundSummary()
  const task = bgInfo ? `bg:${bgInfo}` : (state.currentTask || 'idle')
  let navInfo = state.navigationStatus ? ` nav=${state.navigationStatus}` : ''
  const queueList = state.actionQueue.map(a => a.actionStr)
  const queueStr = queueList.length > 0 ? queueList.join('→') : 'empty'

  const mcData = require('minecraft-data')(bot.version)

  // Utility blocks from DB (furnaces, crafting tables, chests, etc.). A storage block
  // with no container record has never been opened — its contents are unknown. A double
  // chest is recorded under one half, so an opened chest beside it covers the other.
  const STORAGE = new Set(['chest', 'trapped_chest', 'barrel'])
  const opened = (u) => getContainerState(u.x, u.y, u.z) || (u.name !== 'barrel' &&
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => getContainerState(u.x + dx, u.y, u.z + dz)))
  const foundUtils = queryUtilityBlocks(pos, SEARCH_UTILITY).map(u => {
    const d = Math.round(pos.distanceTo(new Vec3(u.x, u.y, u.z)))
    const unopened = STORAGE.has(u.name) && !opened(u) ? ',unopened' : ''
    return `${u.name}@${u.x},${u.y},${u.z}(${d}m${unopened})`
  })

  // Container locations from DB (contents accessible via take/deposit actions)
  const containers = getNearbyContainers(pos, SEARCH_FAR)
  const containerParts = []
  for (const c of containers) {
    const d = Math.round(pos.distanceTo(new Vec3(c.x, c.y, c.z)))
    const itemCount = c.type === 'furnace' || c.type === 'smoker' || c.type === 'blast_furnace'
      ? [c.contents.input, c.contents.fuel, c.contents.output].filter(Boolean).length
      : (c.contents.items?.length || 0)
    const countStr = itemCount > 0 ? `,${itemCount}items` : ',empty'
    containerParts.push(`${c.type}@${c.x},${c.y},${c.z}(${d}m${countStr})`)
  }
  const containerInfo = containerParts.length > 0 ? ` containers=[${containerParts.join(',')}]` : ''
  const utilInfo = foundUtils.length > 0 ? ` stations=${foundUtils.join(',')}` : ''

  const structures = getStructures()
  const structParts = []
  for (const s of structures) {
    if (s.block_count === 0) continue
    const cx = Math.round((s.x1 + s.x2) / 2), cy = s.y1, cz = Math.round((s.z1 + s.z2) / 2)
    const d = Math.round(pos.distanceTo(new Vec3(cx, cy, cz)))
    structParts.push(`"${s.name}"@${cx},${cy},${cz}(${d}m,${s.block_count}blk)`)
  }
  const structInfo = structParts.length > 0 ? ` MY_BUILDS=[${structParts.join(', ')}]` : ''

  const invItems = bot.inventory.items()
  const countItem = (filter) => invItems.filter(i => filter(i.name)).reduce((s, i) => s + i.count, 0)
  const logs = countItem(n => n.includes('_log'))
  const planks = countItem(n => n.includes('_planks'))
  const sticks = countItem(n => n === 'stick')
  const iron = countItem(n => n === 'iron_ingot')
  const rawIron = countItem(n => n === 'raw_iron')
  const coal = countItem(n => n === 'coal' || n === 'charcoal')
  const wool = countItem(n => n.includes('wool'))
  const calcParts = []
  if (logs > 0 || planks > 0) calcParts.push(`${logs}logs=${logs * 4}planks(+${planks}existing=${logs * 4 + planks}total_planks)`)
  if (iron > 0 || rawIron > 0) calcParts.push(`${iron}iron_ingots(+${rawIron}raw_to_smelt=${iron + rawIron}total)`)
  if (coal > 0) calcParts.push(`${coal}coal=${coal * 4}torches`)
  if (sticks > 0) calcParts.push(`${sticks}sticks`)
  if (wool > 0) calcParts.push(`${wool}wool`)
  const calcInfo = calcParts.length > 0 ? ` CALC=[${calcParts.join(', ')}]` : ''

  // Accessibility subtitles — what the bot "hears"
  const now = Date.now()
  const subs = state.recentSubtitles.filter(s => now - s.ts < 8000)
  const subsInfo = subs.length > 0
    ? ` SOUNDS=[${subs.map(s => `"${s.text}"@${s.x},${s.y},${s.z}(${s.dist}m)`).join(', ')}]`
    : ''

  // Result of the model's most recent look/view/scan query (these don't otherwise
  // re-enter context — they were previously chat-only, so the model never saw them).
  const obs = state.lastObservation
  const obsInfo = obs && (Date.now() - obs.ts < 20000) ? ` LOOKED=[${obs.text}]` : ''

  const failInfo = state.lastFailures.length > 0 ? ` RECENT_FAILS=[${state.lastFailures.join(', ')}]` : ''
  const newRecords = renderNew()
  const newInfo = newRecords ? ` NEW=[${newRecords}]` : ''
  // Report mineflayer's real bot.vehicle state, which is driven purely by the
  // server's set_passengers/attach_entity packets (no client-side guessing).
  // Always emit an affirmative RIDING/ON_FOOT token so the model never has to
  // infer its riding state from the absence of a flag.
  let vehicleStr = ' ON_FOOT'
  if (bot.vehicle) {
    // passengers is server seat-order; seat 0 is the controlling seat for
    // steerable mounts (camel, boat), so sail/steer only works as the driver.
    const passengers = bot.vehicle.passengers || []
    const seat = passengers.findIndex(e => e && e.id === bot.entity.id)
    const seatStr = passengers.length > 1
      ? ` SEAT=${seat === 0 ? 'driver' : 'passenger'}(${seat + 1}/${passengers.length})`
      : ''
    vehicleStr = ` RIDING=${bot.vehicle.name || 'vehicle'}${seatStr}`
  }

  // Every online player, each with the best position the bot has: the tracked
  // entity when in render range, else the Locator Bar fix. Which one matters is
  // for the model to judge from the event and the agenda.
  const describePlayer = (name) => {
    const pl = bot.players[name]
    if (pl && pl.entity) {
      const pp = pl.entity.position
      const pdist = Math.round(pp.distanceTo(pos))
      // Player visibility is LOS-tested up to its own cap, independent of the
      // (shorter) nearby= list range, so "can you see me?" works at distance.
      const canSee = pdist <= ranges.sight.playerVisibility &&
        hasLineOfSight(eyePos, pp, pl.entity.height || 1.8)
      if (canSee) nearbyNames.push(name)
      playerDist[name] = pdist
      // Player's own facing (yaw), like a human reading another player's head
      // orientation. Only available while the entity is tracked, same as a
      // vanilla client only rendering orientation for players in render range.
      let pfacingStr = ''
      if (typeof pl.entity.yaw === 'number') {
        const pyaw = (((pl.entity.yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        pfacingStr = `,facing=${facingDirs[Math.round(pyaw / (Math.PI / 4)) % 8]}`
      }
      return `${name}@${Math.floor(pp.x)},${Math.floor(pp.y)},${Math.floor(pp.z)}(${pdist}m,${canSee ? 'visible' : 'NOT_VISIBLE'}${pfacingStr}${equipOf(pl.entity)})`
    }
    // No tracked entity (out of render range). Fall back to the Locator Bar:
    // the server's tracked_waypoint gives a heading — and usually a rough
    // position — toward the player, enough to start walking the right way.
    // Bearing yaw uses mineflayer's lookAt convention: atan2(-dx, -dz).
    const wp = pl && pl.uuid ? bot._waypoints?.get(pl.uuid) : null
    if (wp && (wp.type === 'vec3i' || wp.type === 'chunk')) {
      const tx = wp.type === 'vec3i' ? wp.x : wp.chunkX * 16 + 8
      const tz = wp.type === 'vec3i' ? wp.z : wp.chunkZ * 16 + 8
      const dir = yawToDir(Math.atan2(-(tx - pos.x), -(tz - pos.z)))
      const dist = Math.round(Math.hypot(tx - pos.x, tz - pos.z))
      return wp.type === 'vec3i'
        ? `${name}@${Math.floor(tx)},${wp.y},${Math.floor(tz)}(out_of_range,locator,head=${dir},~${dist}m)`
        : `${name}@~${Math.floor(tx)},~${Math.floor(tz)}(out_of_range,locator_chunk,head=${dir},~${dist}m)`
    }
    if (wp && wp.type === 'azimuth') {
      // Very distant: only a world-frame bearing, no distance. Rebuild a unit
      // delta from the azimuth (atan2(dz,dx)) and reuse the same heading math.
      const dir = yawToDir(Math.atan2(-Math.cos(wp.azimuth), -Math.sin(wp.azimuth)))
      return `${name}@UNKNOWN(out_of_range,locator,head=${dir},far)`
    }
    return `${name}@UNKNOWN(not_in_range)`
  }
  const others = Object.keys(bot.players).filter(n => n !== bot.username).sort()
  const playerPosStr = ` PLAYERS=[${others.map(describePlayer).join(', ') || 'none online'}]`

  // Context "see=" comes purely from the find+LOS survey (the new view) — no ray vision.
  const visionInfo = formatVision(null, { survey: getLastSurvey() })

  let biomeStr = ''
  try {
    const footBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    if (footBlock?.biome) {
      const biomeInfo = mcData.biomes[footBlock.biome.id]
      if (biomeInfo) biomeStr = ` biome=${biomeInfo.name}`
    }
  } catch(e) { console.warn('  [CTX] biome detection err:', e.message) }

  // One all-round ray view feeds both the place guesses and the material layers
  // (BIOMES / TERRAIN / RESOURCES / UNEXPLAINED), so they always agree on what is seen.
  let placesInfo = '', sightInfo = ''
  try {
    const t0 = Date.now()
    const view = lookAround(bot, ranges.sight.viewBlocks)
    const r = recognizeView(view, { maxDistance: ranges.sight.placesBlocks })
    placesInfo = formatPlacesContext(r)
    const summary = summarizeSight({ dimension: bot.game.dimension, eye: view.eye, blocks: view.blocks, places: r?.places || [] })
    sightInfo = ' ' + formatSight(summary, view.dark).split('\n').join(' ')
    const ms = Date.now() - t0
    if (ms > 250) console.log(`  [SIGHT] slow ${ms}ms (snapshot ${view.ms.snapshot.toFixed(0)}, rays ${view.ms.rays.toFixed(0)}, blocks ${view.ms.blocks.toFixed(0)}, places ${r?.ms}) — ${view.blocks.length} blocks`)
  } catch (e) { console.warn('  [CTX] sight err:', e.message) }

  const pathCount = countNearbyPathBlocks(pos)
  const pathInfo = pathCount > 0 ? ` paths=${pathCount}` : ''

  // Blocks occupying the bot's own column — head (suffocation), feet (drowning/
  // hazard, e.g. water/lava/fire), and the floor it stands on (support/fall).
  // The vision survey only reports LOS-visible blocks at range, so these three
  // adjacent blocks are not otherwise surfaced to the model.
  let bodyStr = ''
  try {
    const blockName = (b) => b ? b.name : 'unknown'
    const headBlock = bot.blockAt(pos.offset(0, 1, 0))
    const feetBlock = bot.blockAt(pos)
    const floorBlock = bot.blockAt(pos.offset(0, -1, 0))
    // Lying in a bed is a body state, not a block: feet:yellow_bed alone reads the same
    // whether the bot is asleep in it or standing on it (26.3 once hid the wake-up).
    const bed = bot.isSleeping ? ',in_bed(asleep)' : ''
    bodyStr = ` body=[head:${blockName(headBlock)},feet:${blockName(feetBlock)},floor:${blockName(floorBlock)}${bed}]`
  } catch(e) { console.warn('  [CTX] body block detection err:', e.message) }

  // Names only — the usage syntax lives in the system prompt. Generated from the
  // provider table so a new view becomes askable the moment it is registered.
  const ctxAvail = ` CTX_AVAIL=[${providerNames().join(',')}]`

  // What changed since the context of the previous turn.
  const invCounts = {}
  for (const i of bot.inventory.items()) invCounts[i.name] = (invCounts[i.name] || 0) + i.count
  const snap = snapshot({ pos, hp: bot.health, food: bot.food, held, offhand, inv: invCounts, armor: armorSlots,
    vehicle: vehicleStr.trim(), task, seen: nearbyNames, drops, players: playerDist })
  const delta = renderDelta(state.prevSnapshot, snap)
  state.prevSnapshot = snap
  const deltaInfo = delta ? ` DELTA=[${delta}]` : ''

  const blob = `[pos=${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} dim=${currentDim()} name=${bot.username} facing=${facing}${bodyStr} HP=${Math.round(bot.health)}/20 food=${Math.round(bot.food)}/20${require('../perception/effects').contextLine()} held=${itemLabel(bot.heldItem)} offhand=${itemLabel(bot.inventory.slots[45])} time=${time}${lightStr}${onlineStr} task=${task}${navInfo} queue=${queueStr} nearby=${nearby} inv=${inv}${armorStr}${vehicleStr}${playerPosStr}${utilInfo}${containerInfo}${structInfo}${calcInfo}${visionInfo}${biomeStr}${sightInfo}${placesInfo}${require('../engine/breakPermission').contextLine()}${require('../engine/defendMode').contextLine()}${require('../engine/leadMode').contextLine()}${pathInfo}${subsInfo}${obsInfo}${deltaInfo}${newInfo}${failInfo}${ctxAvail}]`

  let aroundView = ''
  try { aroundView = around() } catch (e) { console.warn('  [CTX] around err:', e.message) }

  // The surroundings, agenda and requested views hang OUTSIDE the blob: they are multi-line,
  // and the blob is parsed elsewhere by splitting on top-level keys, which would mangle them.
  return [blob, aroundView, renderAgenda(), renderNotesBlock(), renderPending()].filter(Boolean).join('\n')
}

module.exports = { getBotContext, itemLabel }
