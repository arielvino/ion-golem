// caveTrail.js — the way the bot walked into a cave, kept so it can walk it back out.
//
// A trail starts where cave:explore is given and restarts wherever the bot is still under open
// sky, so it begins at the mouth (the last spot under open sky). It records where the bot stood
// on the ground, every TRAIL_STEP blocks. A drop of 2+ blocks on it costs blocks to climb back
// (one per block over the first; a 1-block step needs none): `back` adds them up. cave:out walks the points backwards and clears the trail once out.
// Kept per world (cave-trail.json), so it survives a restart.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

const TRAIL_STEP = 1.5      // blocks between recorded points
const SAMPLE_MS = 250
const POINTS_MAX = 4000

let trail = null            // { mouth: {x,y,z}, points: [{x,y,z,climb?}], back, ores: [key], startedAt }
let loadedFor = null

function file() { return state.WORLD_DATA_DIR ? path.join(state.WORLD_DATA_DIR, 'cave-trail.json') : null }

function get() {
  if (loadedFor !== state.WORLD_DATA_DIR) {
    loadedFor = state.WORLD_DATA_DIR
    trail = null
    try { const f = file(); if (f && fs.existsSync(f)) trail = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { trail = null }
  }
  return trail
}

let saveTimer = null
function save() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const f = file(); if (!f) return
      if (trail) fs.writeFileSync(f, JSON.stringify(trail))
      else if (fs.existsSync(f)) fs.unlinkSync(f)
    } catch (e) { console.warn('  [TRAIL] save err:', e.message) }
  }, 1000)
}

function start(mouth) {
  get()
  trail = { mouth: { ...mouth }, points: [{ ...mouth }], back: 0, startedAt: Date.now() }
  save()
  return trail
}

function clear() { get(); trail = null; save() }

// An ore (position key) the bot was stopped for in this cave.
function noteOre(key) {
  const t = get()
  if (!t) return
  if (!t.ores) t.ores = []
  if (!t.ores.includes(key)) { t.ores.push(key); if (t.ores.length > 2000) t.ores.shift(); save() }
}

function feetOf(bot) {
  const p = bot.entity.position
  return { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) }
}

// Note where the bot stands now (on the ground only: mid-fall is no place to stand). Under open
// sky it is not in yet: the trail starts over from there (the mouth is the last such spot).
function note(bot, sky = null) {
  const t = get()
  if (!t || !bot.entity.onGround) return
  const f = feetOf(bot), last = t.points[t.points.length - 1]
  if (sky && sky(bot)) { if (f.x !== t.mouth.x || f.y !== t.mouth.y || f.z !== t.mouth.z) start(f); return }
  if (Math.hypot(f.x - last.x, f.y - last.y, f.z - last.z) < TRAIL_STEP) return
  // Back where it has been: the loop since then is no part of the way out.
  for (let k = 0; k < t.points.length - 2; k++) {
    const q = t.points[k]
    if (Math.abs(q.x - f.x) <= 1 && Math.abs(q.y - f.y) <= 1 && Math.abs(q.z - f.z) <= 1) {
      t.points.length = k + 1
      t.back = t.points.reduce((n, p) => n + (p.climb || 0), 0)
      save()
      return
    }
  }
  const drop = last.y - f.y
  if (drop >= 2) { f.climb = drop - 1; t.back += f.climb }
  t.points.push(f)
  if (t.points.length > POINTS_MAX) t.points.splice(1, 1)
  save()
}

// Record while fn runs. → fn's result.
async function recording(bot, fn, sky = null) {
  const timer = setInterval(() => { try { note(bot, sky) } catch (e) {} }, SAMPLE_MS)
  try { return await fn() } finally { clearInterval(timer); note(bot, sky) }
}

// Blocks walked along the trail.
function length(t = get()) {
  if (!t) return 0
  let n = 0
  for (let i = 1; i < t.points.length; i++) {
    const a = t.points[i - 1], b = t.points[i]
    n += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  }
  return Math.round(n)
}

module.exports = { get, start, clear, note, noteOre, recording, length, feetOf }
