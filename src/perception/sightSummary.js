// sightSummary.js — what the bot sees, in the layers the model reads it by.
//
// Input is one view: every visible block with its position and the biome it sits in. Each
// block gets its role there (config/natural-blocks.js) and lands in one layer:
//
//   biomes       which biomes the view covers, by share of the visible blocks
//   terrain      what the ground of each biome is made of: every material with % and count
//   decoration   natural, on the ground rather than of it (trees, plants, boulders,
//                fossils): count + nearest
//   resources    ores: count + every visible one, nearest first
//   unnatural    not natural here: a structure, a portal or a player's work. Count, nearest,
//                and how far the farthest one is. Places recognize.js made of them are
//                reported beside this (recognize.js formatStructures), not instead of it.
const { roleOf, RESOURCE } = require('../config/natural-blocks')
const { NEAR } = require('./sight')

const BIOME_MIN = 0.01    // biomes under this share of the view are left out
const TERRAIN_MIN = 0.005 // terrain materials under this share of their biome are left out
const LIST_MAX = 20       // decoration / resources / unnatural entries
const DARK_MIN = 0.02     // less of the near space dark than this: no DARK= line
const DIR_DARK = 0.6      // a direction this dark (share of its rays) reads "dark"
const DIR_PART = 0.2      // ... and this, "partly dark"
const DIR_WORDS = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west',
  W: 'west', NW: 'north-west', up: 'above', down: 'below' }

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

// blocks: [{ id, name, x, y, z, biome }] (no air; id = state id). Every layer is grouped by
// block name: it says what the area holds, and a state split (oak_leaves by distance, stairs
// by facing) would only crowd real kinds out of the list.
function summarizeSight({ eye, dimension, blocks }) {
  const biomes = new Map()     // biome -> { n, terrain: Map(name -> n) }
  const found = { decoration: new Map(), resource: new Map(), unnatural: new Map() }   // name -> { n, d2, at, far2 }
  const note = (map, name, b) => {
    const dx = b.x + 0.5 - eye.x, dy = b.y + 0.5 - eye.y, dz = b.z + 0.5 - eye.z, d2 = dx * dx + dy * dy + dz * dz
    const e = map.get(name)
    if (!e) map.set(name, { n: 1, d2, at: b, far2: d2, spots: [{ b, d2 }] })
    else { e.n++; e.spots.push({ b, d2 }); if (d2 < e.d2) { e.d2 = d2; e.at = b } if (d2 > e.far2) e.far2 = d2 }
  }
  for (const b of blocks) {
    let bm = biomes.get(b.biome)
    if (!bm) biomes.set(b.biome, bm = { n: 0, terrain: new Map() })
    bm.n++
    const role = roleOf(b.name, dimension, b.biome)
    if (role === 'terrain') bm.terrain.set(b.name, (bm.terrain.get(b.name) || 0) + 1)
    else if (role === 'resource') note(found.resource, RESOURCE.get(b.name), b)
    else note(found[role ?? 'unnatural'], b.name, b)
  }

  const total = blocks.length || 1
  const biomeList = [...biomes].filter(([, v]) => v.n / total >= BIOME_MIN).sort((a, b) => b[1].n - a[1].n)
  const spot = (b, d2) => ({ dist: Math.round(Math.sqrt(d2)), dir: compass(b.x + 0.5 - eye.x, b.z + 0.5 - eye.z), at: { x: b.x, y: b.y, z: b.z }, ...(b.underwater && { underwater: true }) })
  // all: every block's spot, nearest first (only the resources layer lists them all).
  const listOf = (map, all = false) => [...map].map(([name, e]) => ({
    name, count: e.n, far: Math.round(Math.sqrt(e.far2)), ...spot(e.at, e.d2),
    ...(all && { spots: e.spots.sort((a, b) => a.d2 - b.d2).map(s => spot(s.b, s.d2)) }),
  })).sort((a, b) => b.count - a.count || a.dist - b.dist).slice(0, LIST_MAX)
  return {
    seen: blocks.length,
    biomes: biomeList.map(([name, v]) => ({ name, share: v.n / total })),
    terrain: biomeList.map(([name, v]) => {
      const n = [...v.terrain.values()].reduce((s, c) => s + c, 0) || 1
      return { biome: name, top: [...v.terrain].sort((a, b) => b[1] - a[1])
        .filter(([, c]) => c / n >= TERRAIN_MIN).map(([m, c]) => ({ name: m, count: c, share: c / n })) }
    }).filter(t => t.top.length),
    decoration: listOf(found.decoration),
    resources: listOf(found.resource, true),
    unnatural: listOf(found.unnatural),
  }
}

const pct = (x) => `${Math.round(100 * x)}%`

// The context lines — data only; how to read them belongs in the system prompt. An empty
// layer is left out. Entries: NAME×COUNT nearest DIST DIR@X,Y,Z, and for unnatural blocks
// "(to FARm)" when there are several. Resources list every spot instead of the nearest:
// NAME×COUNT: DIST DIR@X,Y,Z; DIST DIR@X,Y,Z… with " | " between kinds (coords hold commas),
// a spot under seen water marked " underwater".
// dark: lookAround's dark (castRays' near, or null): DARK= is left out when almost nothing near is dark.
function formatSight(s, dark = null) {
  const item = (e) => `${e.name}×${e.count} nearest ${e.dist}m ${e.dir}@${e.at.x},${e.at.y},${e.at.z}`
  const spread = (e) => item(e) + (e.count > 1 ? ` (to ${e.far}m)` : '')
  const lines = []
  if (s.biomes.length) lines.push(`BIOMES=[${s.biomes.map(b => `${b.name} ${pct(b.share)}`).join(', ')}]`)
  if (s.terrain.length) lines.push(`TERRAIN=[${s.terrain.map(t => `${t.biome}: ${t.top.map(m => `${m.name} ${pct(m.share)} (${m.count})`).join(', ')}`).join(' | ')}]`)
  if (s.decoration.length) lines.push(`DECOR=[${s.decoration.map(item).join(', ')}]`)
  const spots = (e) => `${e.name}×${e.count}: ${e.spots.map(p => `${p.dist}m ${p.dir}@${p.at.x},${p.at.y},${p.at.z}${p.underwater ? ' underwater' : ''}`).join('; ')}`
  if (s.resources.length) lines.push(`RESOURCES=[${s.resources.map(spots).join(' | ')}]`)
  if (s.unnatural.length) lines.push(`UNNATURAL=[${s.unnatural.map(spread).join(', ')}]`)
  if (dark && dark.share >= DARK_MIN) {
    const where = (lo, hi) => dark.dirs.filter(([, f]) => f >= lo && f < hi).map(([d]) => DIR_WORDS[d]).join(', ')
    const full = where(DIR_DARK, 2), part = where(DIR_PART, DIR_DARK)
    const stand = dark.here < 1 ? 'darkness' : dark.here < 8 ? 'dim light' : 'light'
    let line = `you stand in ${stand} (${dark.here}/15) | ${pct(dark.share)} of the space within ${NEAR} blocks of you is dark`
    const sides = [full && `dark: ${full}`, part && `partly dark: ${part}`].filter(Boolean)
    if (sides.length && dark.share < 0.95) line += ` — ${sides.join('; ')}`
    lines.push(`DARK=[${line}]`)
  }
  return lines.join('\n')
}

module.exports = { summarizeSight, formatSight }
