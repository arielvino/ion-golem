// visibility.js — "6/6 eyes" visibility: chunk-truth discovery, line-of-sight honesty.
//
// Rationale: the ray-cast vision system (vision.js) conflated *discovery* ("where
// are the blocks?") with *visibility* ("can I see them?") and did both by angular
// sampling, so it misses blocks no ray happened to hit. Here we split the two jobs:
//   - discovery: chunkScan.scanCandidates reads real chunk data (cone-culled,
//                distance-bounded, exposure-filtered so buried blocks are dropped),
//   - honesty:   each candidate is gated by a line-of-sight ray (blockVisible),
// so the bot is told about *every* block it can actually see, and nothing it can't.
// Reading chunk data to enumerate candidates is not x-ray: knowledge is LOS-gated,
// the bot never reports a block without a clear sightline to it.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { rayClear, hasLineOfSight } = require('./vision')
const { scanCandidates } = require('./chunkScan')
const { HAZARDS, RESOURCES } = require('../config/blocks')

const DEG = Math.PI / 180

// Mineflayer's authoritative view direction (node_modules/mineflayer/lib/plugins/ray_trace.js:29).
function viewVector(bot) {
  const yaw = bot.entity.yaw, pitch = bot.entity.pitch
  return new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  )
}

// Cheap cone cull: is `point` within the half-angle (cosHalf = cos(halfAngle)) of the
// look ray from `eye`? One subtract + dot + sqrt — runs BEFORE any LOS ray, so it only
// removes work. cosHalf <= -1 means omnidirectional (no FOV limit).
function inFov(eye, look, point, cosHalf) {
  if (cosHalf <= -1) return true
  const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 1e-6) return true
  const dot = (dx * look.x + dy * look.y + dz * look.z) / len
  return dot >= cosHalf
}

// Is the block at (bx,by,bz) visible from `eye`?
// Tests only the (<=3) faces pointing toward the eye, at their centers, early-exiting
// on the first clear sightline. Face-center sampling (vs the block center) keeps the
// block from occluding itself, and (vs corners) avoids 1px-sliver false positives.
// This is an approximation of true per-pixel visibility, deliberately: a block that is
// ~95% occluded may read as unseen, which is harmless for awareness/navigation.
function blockVisible(eye, bx, by, bz) {
  const faces = []
  if (eye.x > bx + 1) faces.push({ d: eye.x - (bx + 1), p: new Vec3(bx + 1, by + 0.5, bz + 0.5) })
  else if (eye.x < bx) faces.push({ d: bx - eye.x, p: new Vec3(bx, by + 0.5, bz + 0.5) })
  if (eye.y > by + 1) faces.push({ d: eye.y - (by + 1), p: new Vec3(bx + 0.5, by + 1, bz + 0.5) })
  else if (eye.y < by) faces.push({ d: by - eye.y, p: new Vec3(bx + 0.5, by, bz + 0.5) })
  if (eye.z > bz + 1) faces.push({ d: eye.z - (bz + 1), p: new Vec3(bx + 0.5, by + 0.5, bz + 1) })
  else if (eye.z < bz) faces.push({ d: bz - eye.z, p: new Vec3(bx + 0.5, by + 0.5, bz) })

  if (faces.length === 0) return true // eye sits within the block's cell on every axis
  faces.sort((a, b) => b.d - a.d) // most face-on first → best early-exit odds
  for (const f of faces) {
    if (rayClear(eye, f.p)) return true
  }
  return false
}

// "What do I see now?" — summarize visible block types (and entities) around the bot.
// OPTION 3 (honest + bounded): LOS-test exposed candidates NEAREST-FIRST, per type.
// A type reported "many" once it has >K actually-visible blocks (we then stop testing it,
// so a dense type can't run up the LOS bill); a type that never saturates is tested to
// exhaustion, so its count is exact. Every reported block has a verified sightline
// (no x-ray) and every number is either exact or an honest "many" (≥K+1) — never a lie.
// Cost is bounded by the early-stop: abundant terrain saturates fast, rare resources are
// counted exactly. The candidate list MUST be the flat nearest-first scan (not the
// pre-truncated groupNearest map) so exhaustion-vs-saturation is decided on real data.
// opts: { maxDistance=40, cap=60000, fovDegrees=120 (full FOV), omni=false, visibleCap=16 }
function surveyVisible(opts = {}) {
  const bot = state.bot
  if (!bot?.entity) return null
  const maxDistance = opts.maxDistance || 40
  const cap = opts.cap || 60000
  const K = opts.visibleCap || 16
  const omni = opts.omni === true
  const fovDeg = opts.fovDegrees == null ? 120 : opts.fovDegrees
  const cosHalf = omni ? -1 : Math.cos((fovDeg / 2) * DEG)
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const look = viewVector(bot)

  // Discover candidates (cone-culled, distance-bounded, exposure-filtered), nearest-first.
  let candidates = []
  try {
    candidates = scanCandidates({ origin: eye, look, cosHalf, maxDistance, count: cap })
  } catch (e) { candidates = [] }

  // Per-type honest LOS, nearest-first. Skip a type's remaining candidates once it is
  // saturated (>K visible) — that's the cost bound; until then every candidate is tested,
  // so a non-"many" count is exact and a "many" type's nearest is the true nearest visible.
  const blocks = {}
  let visibleCount = 0
  let losTests = 0
  for (const cnd of candidates) {
    const existing = blocks[cnd.name]
    if (existing && existing.many) continue // saturated: don't even LOS-test (bounds cost)
    losTests++
    if (!blockVisible(eye, cnd.x, cnd.y, cnd.z)) continue
    visibleCount++
    const rec = existing || (blocks[cnd.name] = { count: 0, many: false, nearest: null, nearestDist: Infinity })
    rec.count++
    if (cnd.dist < rec.nearestDist) { rec.nearestDist = cnd.dist; rec.nearest = { x: cnd.x, y: cnd.y, z: cnd.z, dist: Math.round(cnd.dist) } }
    if (rec.count > K) rec.many = true // >K verified-visible → report "many", stop testing
  }

  // Entities: same FOV cull, then the existing multi-point entity LOS check.
  const entities = []
  for (const e of Object.values(bot.entities || {})) {
    if (e === bot.entity || !e.position) continue
    const dist = bot.entity.position.distanceTo(e.position)
    if (dist > maxDistance) continue
    const h = e.height || 1.8
    const center = e.position.offset(0, h * 0.5, 0)
    if (!inFov(eye, look, center, cosHalf)) continue
    if (!hasLineOfSight(eye, e.position, h)) continue
    entities.push({
      name: e.username || e.name || e.displayName || 'entity',
      x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z),
      dist: Math.round(dist),
    })
  }
  entities.sort((a, b) => a.dist - b.dist)

  _lastSurvey = { blocks, entities, candidatesScanned: candidates.length, losTests, visibleCount, fov: omni ? 'omni' : fovDeg, maxDistance }
  return _lastSurvey
}

let _lastSurvey = null
function getLastSurvey() { return _lastSurvey }

// ─── Navigation feed ───────────────────────────────────────────────
// surveyForNav: the omni, LOS-honest replacement for castVisionRays as the
// navigation planner's knowledge source. Two honest writes per survey:
//   1. every omni-visible SOLID (scanCandidates → blockVisible) is upserted at
//      its true position — accurate per-block discovery, no angular ray gaps.
//   2. for near candidates, the cells the clear eye→block sightline passes
//      THROUGH are recorded at their real block name (air/water/…). Those cells
//      are provably visible (the ray reached the solid), so this stays no-x-ray,
//      and it is what makes seen drops/pits real instead of staying "unknown".
// Nothing the bot can't see is ever written. Feeds the same `blocks` DB the
// planner reads, so optimistic-unknown planning converges as the bot looks around.

// Voxel-walk the clear sightline eye→(block center), recording the real name of
// each integer cell strictly before the solid. Cells already in `seen` are skipped.
function _markSightline(eye, cnd, seen, writes) {
  const bot = state.bot
  const tx = cnd.x + 0.5, ty = cnd.y + 0.5, tz = cnd.z + 0.5
  const dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist < 1.3) return 0
  const steps = Math.ceil(dist * 2)
  const sx = dx / steps, sy = dy / steps, sz = dz / steps
  let lastKey = null, n = 0
  for (let i = 1; i < steps; i++) {
    const bx = Math.floor(eye.x + sx * i), by = Math.floor(eye.y + sy * i), bz = Math.floor(eye.z + sz * i)
    if (bx === cnd.x && by === cnd.y && bz === cnd.z) break // reached the solid itself
    const key = bx + ',' + by + ',' + bz
    if (key === lastKey) continue
    lastKey = key
    if (seen.has(key)) continue
    seen.add(key)
    let name = 'air'
    try { const b = bot.blockAt(new Vec3(bx, by, bz)); if (b) name = b.name } catch (e) { continue }
    writes.push({ x: bx, y: by, z: bz, name })
    n++
  }
  return n
}

function surveyForNav({ maxDistance = 32, passableRange = 22, maxCandidates = 2000 } = {}) {
  const bot = state.bot
  if (!bot?.entity || !state.stmts?.upsertBlock || !state.db) return null
  const eye = bot.entity.position.offset(0, 1.62, 0)

  let candidates = []
  try { candidates = scanCandidates({ origin: eye, cosHalf: -1, maxDistance, count: maxCandidates }) }
  catch (e) { return null }

  const tick = bot.time?.age || 0
  const writes = []         // {x,y,z,name}
  const seen = new Set()    // "x,y,z" dedup across solids + sightline cells
  let solids = 0, passables = 0, losTests = 0
  for (const cnd of candidates) {
    losTests++
    if (!blockVisible(eye, cnd.x, cnd.y, cnd.z)) continue
    const sk = cnd.x + ',' + cnd.y + ',' + cnd.z
    if (!seen.has(sk)) { seen.add(sk); writes.push({ x: cnd.x, y: cnd.y, z: cnd.z, name: cnd.name }); solids++ }
    if (cnd.dist <= passableRange) passables += _markSightline(eye, cnd, seen, writes)
  }

  try {
    state.db.transaction(() => {
      for (const w of writes) state.stmts.upsertBlock.run(w.x, w.y, w.z, w.name, tick)
    })()
  } catch (e) { console.warn('  [navSurvey] upsert err:', e.message); return null }

  return { solids, passables, losTests, candidates: candidates.length, writes: writes.length }
}

const SHORTEN = (n) => n.replace('deepslate_', 'deep_').replace('_leaves', '_leaf').replace('_planks', '_plk')

function formatSurvey(s) {
  if (!s) return ''
  const parts = []
  const entries = Object.entries(s.blocks)
  entries.sort((a, b) => {
    const ah = HAZARDS.has(a[0]) ? 0 : 1, bh = HAZARDS.has(b[0]) ? 0 : 1
    if (ah !== bh) return ah - bh
    const ar = RESOURCES.has(a[0]) ? 0 : 1, br = RESOURCES.has(b[0]) ? 0 : 1
    if (ar !== br) return ar - br
    return b[1].count - a[1].count
  })
  const strs = entries.slice(0, 16).map(([name, r]) => {
    const n = SHORTEN(name), at = r.nearest
    const c = r.many ? 'many' : r.count
    return r.count > 1 ? `${n}x${c}@${at.x},${at.y},${at.z}` : `${n}@${at.x},${at.y},${at.z}`
  })
  if (strs.length) parts.push(`see=[${strs.join(',')}]`)
  if (s.entities.length) {
    parts.push(`mobs=[${s.entities.slice(0, 8).map(e => `${e.name}@${e.x},${e.y},${e.z}`).join(',')}]`)
  }
  const fovStr = s.fov === 'omni' ? 'omni' : `${s.fov}°`
  parts.push(`(${s.visibleCount} vis/${s.losTests} los/${s.candidatesScanned} scan, fov ${fovStr}, r${s.maxDistance})`)
  return ` VIEW=[${parts.join(' | ')}]`
}

module.exports = { viewVector, inFov, blockVisible, surveyVisible, formatSurvey, getLastSurvey, surveyForNav }
