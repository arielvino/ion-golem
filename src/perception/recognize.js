// recognize.js — "what kind of place is that?" from a few visible cues.
//
// The reverse of a query. Instead of "where is the nearest X", glance around for every
// cue any known place is made of, keep only what is actually in sight, group what sits
// together, and guess what each group is:
//
//   1. search   one palette-skip pass over the loaded chunks for the union of all
//               fingerprint cues (chunkScan) — discovery only, nothing is known yet
//   2. see      LOS-test the hits nearest-first per type; hidden hits are dropped HERE,
//               before grouping, so a hidden bell can neither vote nor decide which
//               planks belong together (that would be x-ray by the back door)
//   3. group    single-linkage clustering of the visible cues
//   4. guess    score every cluster against every fingerprint → ranked hypotheses, each
//               with the cues that would confirm it and have not been seen yet
//
// The output is a guess, not a fact: "village 0.6 | outpost 0.4" is the honest answer
// to {planks, fence, iron_golem}. The missing cues are what to look for next.
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { FINGERPRINTS } = require('../config/fingerprints')
const { scanCandidates } = require('./chunkScan')
const { blockVisible } = require('./visibility')
const { hasLineOfSight } = require('./vision')

const LINK = 10          // blocks: two visible cues closer than this belong to one place
const VISIBLE_CAP = 16   // per block type: stop LOS-testing once this many are seen
const COUNT_SAT = 8      // per cue: sightings beyond this add no more evidence
const OFF_BIOME = 0.4    // score factor for a kind seen outside the biomes it generates in

const matches = (key, name) => key.startsWith('*') ? name.endsWith(key.slice(1)) : name === key

// Resolve the fingerprint table against this version's block list, once per dimension.
// Kinds that cannot exist in `dimension` are dropped here, so their cues are never
// searched for (no nether bricks scan in the overworld). A null dimension keeps all.
// → { idToName: stateId → block name (the union of every cue), entityCues: Set,
//     kinds: [{ kind, minScore, biomes: Set|null, blockCues: [{key,w,names:Set}], entityCues: [{key,w}] }] }
let _compiled = null
function compile(mcData, dimension = null) {
  const key = `${mcData.version?.minecraftVersion || 'x'}/${dimension}`
  if (_compiled?.key === key) return _compiled
  const idToName = new Map()
  const entityCues = new Set()
  const here = FINGERPRINTS.filter(fp => !dimension || !fp.dimensions || fp.dimensions.includes(dimension))
  const kinds = here.map(fp => {
    const blockCues = Object.entries(fp.blocks).map(([k, w]) => {
      const names = new Set(mcData.blocksArray.filter(b => matches(k, b.name)).map(b => b.name))
      for (const n of names) {
        const b = mcData.blocksByName[n]
        for (let id = b.minStateId; id <= b.maxStateId; id++) idToName.set(id, n)
      }
      return { key: k, w, names }
    })
    for (const k of Object.keys(fp.entities)) entityCues.add(k)
    return { kind: fp.kind, minScore: fp.minScore, biomes: fp.biomes ? new Set(fp.biomes) : null, blockCues, entityCues: Object.entries(fp.entities).map(([k, w]) => ({ key: k, w })) }
  })
  _compiled = { key, idToName, entityCues, kinds }
  return _compiled
}

// Steps 1+2: every visible cue within range, blocks and entities alike.
function visibleCues(eye, maxDistance, c) {
  const bot = state.bot
  const candidates = scanCandidates({ origin: eye, cosHalf: -1, maxDistance, count: 20000, idToName: c.idToName })
  const seenPerName = new Map()
  const out = []
  let losTests = 0
  for (const cnd of candidates) {
    const n = seenPerName.get(cnd.name) || 0
    if (n >= VISIBLE_CAP) continue
    if (state.stmts?.isPlaced?.get(cnd.x, cnd.y, cnd.z)) continue // our own builds are not a place
    losTests++
    if (!blockVisible(eye, cnd.x, cnd.y, cnd.z)) continue
    seenPerName.set(cnd.name, n + 1)
    out.push({ name: cnd.name, x: cnd.x, y: cnd.y, z: cnd.z, entity: false })
  }
  for (const e of Object.values(bot.entities || {})) {
    if (e === bot.entity || !e.position || !c.entityCues.has(e.name)) continue
    if (e.position.distanceTo(eye) > maxDistance) continue
    if (!hasLineOfSight(eye, e.position, e.height || 1.8)) continue
    out.push({ name: e.name, x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), entity: true })
  }
  return { cues: out, candidates: candidates.length, losTests }
}

// Step 3: single-linkage clusters (union-find over pairs closer than LINK).
function cluster(cues) {
  const parent = cues.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  const L2 = LINK * LINK
  for (let i = 0; i < cues.length; i++) {
    for (let j = i + 1; j < cues.length; j++) {
      const dx = cues[i].x - cues[j].x, dy = cues[i].y - cues[j].y, dz = cues[i].z - cues[j].z
      if (dx * dx + dy * dy + dz * dz <= L2) parent[find(i)] = find(j)
    }
  }
  const groups = new Map()
  for (let i = 0; i < cues.length; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(cues[i])
  }
  return [...groups.values()]
}

// Step 4: score one cluster against every kind. `biome` is the biome at the cluster's
// center (null = unknown, no prior applied).
function guess(members, c, biome = null) {
  const counts = new Map()
  for (const m of members) counts.set(m.name, (counts.get(m.name) || 0) + 1)
  const evidence = (count, w) => count > 0 ? w * (1 + Math.log2(Math.min(count, COUNT_SAT))) : 0

  const hyps = []
  for (const k of c.kinds) {
    let score = 0, hit = 0
    const missing = []
    for (const cue of k.blockCues) {
      let n = 0
      for (const name of cue.names) n += counts.get(name) || 0
      if (n) { score += evidence(n, cue.w); hit++ } else missing.push(cue)
    }
    for (const cue of k.entityCues) {
      const n = counts.get(cue.key) || 0
      if (n) { score += evidence(n, cue.w); hit++ } else missing.push(cue)
    }
    // one cue type alone is a coincidence, not a place
    if (hit < 2) continue
    if (biome && k.biomes && !k.biomes.has(biome)) score *= OFF_BIOME
    if (score < k.minScore) continue
    missing.sort((a, b) => b.w - a.w)
    hyps.push({ kind: k.kind, score, missing: missing.slice(0, 3).map(m => m.key) })
  }
  const total = hyps.reduce((s, h) => s + h.score, 0)
  for (const h of hyps) h.share = h.score / total
  hyps.sort((a, b) => b.score - a.score)
  return { counts, hyps }
}

// Biome is read from chunk data, but it is not hidden knowledge: the center sits among
// visible cues, and a biome shows on its surface (grass tint, sand, snow).
function biomeAt(bot, mcData, at) {
  try {
    const id = bot.world.getBiome(new Vec3(at.x, at.y, at.z))
    return mcData.biomes[id]?.name || null
  } catch { return null }
}

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

// → { places: [{ at:{x,y,z}, dist, dir, counts: Map, hyps: [{kind,score,share,missing}] }],
//     unrecognized, candidates, losTests, visible, ms }
function recognize({ maxDistance = 48 } = {}) {
  const bot = state.bot
  if (!bot?.entity) return null
  const t0 = Date.now()
  const mcData = require('minecraft-data')(bot.version)
  const c = compile(mcData, bot.game?.dimension || null)
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const { cues, candidates, losTests } = visibleCues(eye, maxDistance, c)

  const places = []
  let unrecognized = 0
  for (const members of cluster(cues)) {
    const at = { x: 0, y: 0, z: 0 }
    for (const m of members) { at.x += m.x; at.y += m.y; at.z += m.z }
    for (const a of ['x', 'y', 'z']) at[a] = Math.round(at[a] / members.length)
    const biome = biomeAt(bot, mcData, at)
    const { counts, hyps } = guess(members, c, biome)
    if (hyps.length === 0) { unrecognized++; continue }
    const dx = at.x - eye.x, dy = at.y - eye.y, dz = at.z - eye.z
    places.push({ at, biome, dist: Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz)), dir: compass(dx, dz), counts, hyps })
  }
  places.sort((a, b) => a.dist - b.dist)
  return { places, unrecognized, candidates, losTests, visible: cues.length, maxDistance, ms: Date.now() - t0 }
}

function formatRecognition(r) {
  if (!r) return 'places: no bot yet'
  const head = `places r${r.maxDistance}: ${r.places.length} recognized, ${r.unrecognized} unrecognized group(s)`
  const lines = r.places.map(p => {
    const guesses = p.hyps.map(h => `${h.kind} ${h.share.toFixed(2)}`).join(' | ')
    const seen = [...p.counts].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n}×${k}`).join(' ')
    const confirm = p.hyps.slice(0, 2).map(h => `${h.kind}: ${h.missing.join(', ') || '—'}`).join('; ')
    return `  ~${p.dist}m ${p.dir} @${p.at.x},${p.at.y},${p.at.z}${p.biome ? ` (${p.biome})` : ''}: ${guesses}\n    seen: ${seen}\n    would confirm → ${confirm}`
  })
  return [head, ...lines].join('\n')
}

module.exports = { recognize, formatRecognition, compile, cluster, guess }
