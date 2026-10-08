// fastworld.js — allocation-free block reads for the LOS hot path.
//
// bot.blockAt() constructs a full prismarine Block (name, properties, boundingBox,
// hardness, drops) and needs a Vec3 argument. Every LOS ray only ever asks one
// question — "is this cell see-through / walk-through?" — so it was paying for an
// object graph to read one bit. At ~45k calls per nav survey that dominated the
// perception budget.
//
// Here a raycast reads the chunk section's palette container directly by index and
// answers from a Uint8Array keyed on block STATE id. No Vec3, no Block, no string
// hashing. Same source of truth as bot.blockAt (bot.world's loaded columns), so this
// is not x-ray — it is the identical data, read cheaply.
const state = require('../core/state')

// ── state-id lookup tables ───────────────────────────────────────────────
// A Set<name> membership test costs a Block construction + string hash. The same
// predicate as a Uint8Array indexed by state id is a single array read.
const _lutCache = new Map()   // versionKey -> Map<nameSet, Uint8Array>

// NOTE: mcData.blocksByStateId is a plain OBJECT, not an array — its `.length` is
// undefined. Sizing a table from it yields a zero-length buffer that silently rejects
// every lookup. Always derive the bound from blocksArray.maxStateId.
function maxStateId(mcData) {
  let maxId = 0
  for (const b of mcData.blocksArray) {
    if (b.maxStateId != null && b.maxStateId > maxId) maxId = b.maxStateId
  }
  return maxId
}

function stateLUT(mcData, nameSet) {
  const vKey = mcData.version?.minecraftVersion || 'x'
  let perVersion = _lutCache.get(vKey)
  if (!perVersion) _lutCache.set(vKey, perVersion = new Map())
  const hit = perVersion.get(nameSet)
  if (hit) return hit

  const lut = new Uint8Array(maxStateId(mcData) + 1)
  for (const b of mcData.blocksArray) {
    if (!nameSet.has(b.name) || b.minStateId == null) continue
    for (let id = b.minStateId; id <= b.maxStateId; id++) lut[id] = 1
  }
  perVersion.set(nameSet, lut)
  return lut
}

// State id -> block name, as a plain array indexed by id (mcData.blocksByStateId is
// already this shape; we cache the name strings to skip the per-read property hop).
const _nameCache = new Map()
function stateNames(mcData) {
  const vKey = mcData.version?.minecraftVersion || 'x'
  const hit = _nameCache.get(vKey)
  if (hit) return hit
  const byState = mcData.blocksByStateId
  const max = maxStateId(mcData)
  const names = new Array(max + 1)
  for (let i = 0; i <= max; i++) names[i] = byState[i]?.name
  _nameCache.set(vKey, names)
  return names
}

// ── column accessor ──────────────────────────────────────────────────────
// Rays are spatially coherent: consecutive voxels almost always land in the same
// chunk column, so a single-entry cache hits well over 90% of the time and needs no
// invalidation policy beyond chunk unload (below). A Map cache would add staleness
// risk for a few percent more hit rate — not worth it.
// The empty sentinel MUST be NaN, not -1: the key is `cx * 8388608 + cz`, so chunk
// (0,-1) computes to exactly -1 and would collide with the sentinel — that chunk would
// then hit the cache, read _lastCol === null, and report UNLOADED, blocking every ray
// through it. NaN can never equal a computed key, so `key === _lastKey` is simply false
// whenever the cache is empty.
let _lastKey = NaN
let _lastCol = null
let _unloadHooked = null    // the bot instance we attached the invalidation listeners to

const UNLOADED = -1         // column not loaded — caller decides (LOS treats as blocked)
const EMPTY_SECTION = -2    // section absent — prismarine treats this as all-air

function _hookUnload(bot) {
  if (_unloadHooked === bot) return
  _unloadHooked = bot
  _lastKey = NaN; _lastCol = null
  // A column object is replaced (not mutated) on unload AND on reload — prismarine's
  // setColumn swaps in a new Column and emits chunkColumnLoad, so listening only for
  // unload would let a cached reference keep serving blocks from the superseded object
  // after a chunk resend. Both events clear it; block updates mutate the live column in
  // place and need no invalidation.
  try {
    const clear = () => { _lastKey = NaN; _lastCol = null }
    bot.world.on('chunkColumnUnload', clear)
    bot.world.on('chunkColumnLoad', clear)
  } catch (e) { /* no emitter */ }
}

// Raw block state id at world coords. Returns UNLOADED / EMPTY_SECTION sentinels.
// (x >> 4) is floor-divide for negatives, (x & 15) is the positive modulo — both
// correct across the origin, unlike Math.floor(x/16) + (x%16).
function getState(x, y, z) {
  const bot = state.bot
  if (!bot?.world) return UNLOADED
  if (_unloadHooked !== bot) _hookUnload(bot)

  const cx = x >> 4, cz = z >> 4
  const key = cx * 8388608 + cz
  let col
  if (key === _lastKey) {
    col = _lastCol
  } else {
    col = bot.world.getColumn(cx, cz) || null
    _lastKey = key; _lastCol = col
  }
  if (!col) return UNLOADED

  const minY = col.minY ?? -64
  const dy = y - minY
  const sIdx = dy >> 4
  const secs = col.sections
  if (!secs || sIdx < 0 || sIdx >= secs.length) return UNLOADED
  const sec = secs[sIdx]
  if (!sec || !sec.data) return EMPTY_SECTION
  return sec.data.get(((dy & 15) << 8) | ((z & 15) << 4) | (x & 15))
}

// Is this cell a member of `lut` (a state-id table from stateLUT)? Unloaded reads as
// false (conservatively blocking); an absent section reads as air, hence true, which
// matches what bot.blockAt would have reported for the same cell.
function inLUT(lut, x, y, z) {
  const id = getState(x, y, z)
  if (id === EMPTY_SECTION) return true
  if (id < 0) return false
  return id < lut.length && lut[id] === 1
}

// The state id as block memory stores it: an absent section is air (0), unloaded is null.
function stateAt(x, y, z) {
  const id = getState(x, y, z)
  if (id === EMPTY_SECTION) return 0
  return id < 0 ? null : id
}

function nameAt(names, x, y, z) {
  const id = getState(x, y, z)
  if (id === EMPTY_SECTION) return 'air'
  if (id < 0) return null
  return names[id]
}

module.exports = { stateLUT, stateNames, maxStateId, getState, stateAt, inLUT, nameAt, UNLOADED, EMPTY_SECTION }
