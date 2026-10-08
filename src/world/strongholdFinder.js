// strongholdFinder.js — where the eyes of ender point.
//
// A thrown eye flies from where it spawns straight toward the nearest stronghold
// (measured on 26.1: a dead-straight line, the bearing to `locate`'s stronghold
// point to within 0.02°) and stops after 12 blocks. If the stronghold is within 12
// blocks it flies onto it instead. So every throw is an exact ray, and two rays from
// points a few dozen blocks apart, sideways to the bearing, cross on the stronghold.
// One ray alone is narrowed by where strongholds can be: default worldgen puts them
// in rings around 0,0 (RINGS), so the ray is only worth walking where it is in one.
//
// Throws are kept per bot in eye-throws.json (overworld only: eyes don't fly in the
// Nether or the End).
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

const KEEP = 6
const MIN_CROSS = 0.5 * Math.PI / 180  // rays closer to parallel than this don't fix a point
const AGREE = 24                       // blocks: a ray further than this from the fix points at another stronghold
const SIGMA = 0.0001                   // rad: how far one measured bearing may be off (3 throws 2km out crossed within 0.05m of `locate`: ~1e-5)
// Java stronghold rings: inner and outer distance from 0,0.
const RINGS = [[1280, 2816], [4352, 5888], [7424, 8960], [10496, 12032], [13568, 15104], [16640, 18176], [19712, 21248], [22784, 24320]]
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']   // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

function storeFile() { return state.BOT_DATA_DIR ? path.join(state.BOT_DATA_DIR, 'eye-throws.json') : null }

function load() {
  if (state.eyeThrows === undefined) {
    state.eyeThrows = { throws: [], found: null }
    try { const f = storeFile(); if (f && fs.existsSync(f)) Object.assign(state.eyeThrows, JSON.parse(fs.readFileSync(f, 'utf8'))) } catch (e) {}
  }
  return state.eyeThrows
}

function save() {
  try { const f = storeFile(); if (f) fs.writeFileSync(f, JSON.stringify(state.eyeThrows)) } catch (e) {}
}

// A throw from x,z whose eye flew along the unit vector dx,dz.
function addThrow(x, z, dx, dz) {
  const s = load()
  s.throws.push({ x, z, dx, dz, at: Date.now() })
  s.throws = s.throws.slice(-KEEP)
  save()
}

// The eye flew onto the stronghold: it is under x,z.
function setFound(x, z) { load().found = { x, z, at: Date.now() }; save() }

function clear() { state.eyeThrows = { throws: [], found: null }; save() }

// Least-squares crossing of the rays: the point nearest all of them. Null while
// they are (near) parallel or it lies behind a throw.
function crossing(throws) {
  if (throws.length < 2) return null
  let widest = 0
  for (let i = 0; i < throws.length; i++) {
    for (let j = i + 1; j < throws.length; j++) {
      const a = throws[i], b = throws[j]
      widest = Math.max(widest, Math.abs(a.dx * b.dz - a.dz * b.dx))   // sin of the angle between them
    }
  }
  if (widest < Math.sin(MIN_CROSS)) return null
  // Σ (I − u uᵀ) p = Σ (I − u uᵀ) o
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0
  for (const t of throws) {
    const m11 = 1 - t.dx * t.dx, m12 = -t.dx * t.dz, m22 = 1 - t.dz * t.dz
    a11 += m11; a12 += m12; a22 += m22
    b1 += m11 * t.x + m12 * t.z; b2 += m12 * t.x + m22 * t.z
  }
  const det = a11 * a22 - a12 * a12
  if (Math.abs(det) < 1e-12) return null
  const x = (b1 * a22 - b2 * a12) / det, z = (a11 * b2 - a12 * b1) / det
  if (throws.some(t => (x - t.x) * t.dx + (z - t.z) * t.dz <= 0)) return null
  const off = Math.max(...throws.map(t => Math.abs((x - t.x) * t.dz - (z - t.z) * t.dx)))
  // A bearing off by SIGMA slides the crossing along the other ray by range·SIGMA/sin(angle).
  const err = Math.max(...throws.map(t => Math.hypot(x - t.x, z - t.z))) * SIGMA / widest
  return { x, z, off, err }
}

// Where along one ray a stronghold can be: the first stretch of it inside a ring.
function ringStretch(t) {
  const b = t.x * t.dx + t.z * t.dz, c0 = t.x * t.x + t.z * t.z
  // |o + s·u|² = r²  →  s² + 2bs + c0 − r² = 0
  const at = (r) => { const d = b * b - c0 + r * r; return d < 0 ? null : [-b - Math.sqrt(d), -b + Math.sqrt(d)] }
  for (const [n, [rin, rout]] of RINGS.entries()) {
    const out = at(rout)
    if (!out || out[1] <= 0) continue
    const inn = at(rin)
    // The ray is in the ring on [out0, in0] and [in1, out1] (or all of [out0, out1] if it misses the inner circle).
    const spans = inn ? [[out[0], inn[0]], [inn[1], out[1]]] : [[out[0], out[1]]]
    for (const [s0, s1] of spans) {
      if (s1 <= 0) continue
      const a = Math.max(s0, 0)
      return { ring: n + 1, inner: rin, outer: rout, from: { x: t.x + a * t.dx, z: t.z + a * t.dz }, to: { x: t.x + s1 * t.dx, z: t.z + s1 * t.dz } }
    }
  }
  return null
}

// Context line — data only; how to use it lives in the system prompt.
function contextLine() {
  const s = load()
  if (!s.throws.length && !s.found) return ''
  const bot = state.bot
  const p = bot?.entity?.position
  const r = Math.round
  const parts = []
  if (s.found) {
    const d = p ? ` ${r(Math.hypot(s.found.x - p.x, s.found.z - p.z))}m ${compass(s.found.x - p.x, s.found.z - p.z)}` : ''
    parts.push(`stronghold_under=${r(s.found.x)},${r(s.found.z)}${d}`)
  }
  for (const t of s.throws.slice(-3)) {
    parts.push(`throw@${r(t.x)},${r(t.z)}→${compass(t.dx, t.dz)}(per100:${t.dx >= 0 ? '+' : ''}${r(t.dx * 100)},${t.dz >= 0 ? '+' : ''}${r(t.dz * 100)})`)
  }
  if (!s.found) {
    const fix = crossing(s.throws)
    if (fix && fix.off <= AGREE) {
      const d = p ? ` ${r(Math.hypot(fix.x - p.x, fix.z - p.z))}m ${compass(fix.x - p.x, fix.z - p.z)}` : ''
      parts.push(`crossing=${r(fix.x)},${r(fix.z)}±${Math.max(1, r(fix.err))}m${d}`)
    } else if (fix) {
      parts.push(`crossing=none(throws disagree by ${r(fix.off)}m)`)
    } else {
      const last = s.throws[s.throws.length - 1]
      const st = last && ringStretch(last)
      parts.push(s.throws.length > 1 ? 'crossing=none(rays near parallel)' : 'crossing=none(one ray)')
      if (st) parts.push(`ring${st.ring}(${st.inner}-${st.outer})_on_ray=${r(st.from.x)},${r(st.from.z)}..${r(st.to.x)},${r(st.to.z)}`)
    }
  }
  return ` EYES=[${parts.join(' ')}]`
}

module.exports = { load, addThrow, setFound, clear, crossing, ringStretch, contextLine }
