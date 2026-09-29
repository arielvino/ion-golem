// sightSummary.js — what the bot sees, in the layers the model reads it by.
//
// Input is one view: every visible block with its position and the biome it sits in, plus
// the places recognize.js made of the same view. Each block gets its role there
// (config/natural-blocks.js) and lands in one layer:
//
//   biomes       which biomes the view covers, by share of the visible blocks
//   terrain      the ordinary material of each biome: its top TERRAIN_TOP names with %
//   resources    natural but rare and worth going for (ores, food plants): count + nearest
//   places       recognized structures (recognize.js reads the view on its own; natural
//                blocks such as obsidian can be its cues too)
//   unexplained  not natural here and not part of a recognized place: a player, or a
//                structure no fingerprint knows. count + nearest
const { roleOf, RESOURCE } = require('../config/natural-blocks')

const TERRAIN_TOP = 5
const BIOME_MIN = 0.01    // biomes under this share of the view are left out
const TERRAIN_MIN = 0.005 // terrain materials under this share of their biome are left out
const LIST_MAX = 10       // resources / unexplained entries

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

// blocks: [{ name, x, y, z, biome }] (no air). places: recognizeCues(...).places or [].
function summarizeSight({ dimension, eye, blocks, places = [] }) {
  const explained = new Set(places.flatMap(p => [...p.counts.keys()]))
  const biomes = new Map()     // biome -> { n, terrain: Map(name -> n) }
  const found = { resource: new Map(), unexplained: new Map() }   // label -> { n, d2, at }
  const note = (map, label, b) => {
    const dx = b.x + 0.5 - eye.x, dy = b.y + 0.5 - eye.y, dz = b.z + 0.5 - eye.z, d2 = dx * dx + dy * dy + dz * dz
    const e = map.get(label)
    if (!e) map.set(label, { n: 1, d2, at: b })
    else { e.n++; if (d2 < e.d2) { e.d2 = d2; e.at = b } }
  }
  for (const b of blocks) {
    let bm = biomes.get(b.biome)
    if (!bm) biomes.set(b.biome, bm = { n: 0, terrain: new Map() })
    bm.n++
    const role = roleOf(b.name, dimension, b.biome)
    if (role === 'terrain') bm.terrain.set(b.name, (bm.terrain.get(b.name) || 0) + 1)
    else if (role === 'resource') note(found.resource, RESOURCE.get(b.name), b)
    else if (!explained.has(b.name)) note(found.unexplained, b.name, b)
  }

  const total = blocks.length || 1
  const biomeList = [...biomes].filter(([, v]) => v.n / total >= BIOME_MIN).sort((a, b) => b[1].n - a[1].n)
  const listOf = (map) => [...map].map(([name, e]) => ({
    name, count: e.n, dist: Math.round(Math.sqrt(e.d2)), dir: compass(e.at.x + 0.5 - eye.x, e.at.z + 0.5 - eye.z),
    at: { x: e.at.x, y: e.at.y, z: e.at.z },
  })).sort((a, b) => a.dist - b.dist).slice(0, LIST_MAX)
  return {
    biomes: biomeList.map(([name, v]) => ({ name, share: v.n / total })),
    terrain: biomeList.map(([name, v]) => {
      const n = [...v.terrain.values()].reduce((s, c) => s + c, 0) || 1
      return { biome: name, top: [...v.terrain].sort((a, b) => b[1] - a[1]).slice(0, TERRAIN_TOP)
        .filter(([, c]) => c / n >= TERRAIN_MIN).map(([m, c]) => ({ name: m, share: c / n })) }
    }),
    resources: listOf(found.resource),
    unexplained: listOf(found.unexplained),
  }
}

const pct = (x) => `${Math.round(100 * x)}%`

// The context lines — data only; how to read them belongs in the system prompt. An empty
// layer is left out. Entries: NAMExCOUNT@X,Y,Z (the nearest one) DIST DIR.
function formatSight(s) {
  const item = (e) => `${e.name}x${e.count}@${e.at.x},${e.at.y},${e.at.z} ${e.dist}m ${e.dir}`
  const lines = []
  if (s.biomes.length) lines.push(`BIOMES=[${s.biomes.map(b => `${b.name} ${pct(b.share)}`).join(', ')}]`)
  if (s.terrain.length) lines.push(`TERRAIN=[${s.terrain.map(t => `${t.biome}: ${t.top.map(m => `${m.name} ${pct(m.share)}`).join(', ')}`).join(' | ')}]`)
  if (s.resources.length) lines.push(`RESOURCES=[${s.resources.map(item).join(', ')}]`)
  if (s.unexplained.length) lines.push(`UNEXPLAINED=[${s.unexplained.map(item).join(', ')}]`)
  return lines.join('\n')
}

module.exports = { summarizeSight, formatSight, TERRAIN_TOP }
