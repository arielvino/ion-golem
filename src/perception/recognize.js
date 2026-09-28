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
const MERGE = 32         // blocks: same-kind places whose nearest members are this close are one
                         // place (a village's houses); measured edge-to-edge, not center-to-center,
                         // because a sprawling village's halves have centers 45+ blocks apart
const VISIBLE_CAP = 16   // per block type: stop LOS-testing once this many are seen
const COUNT_SAT = 8      // per cue: sightings beyond this add no more evidence
const OFF_BIOME = 0.4    // score factor for a kind seen outside the biomes it generates in

const matches = (key, name) => key.startsWith('*') ? name.endsWith(key.slice(1)) : name === key

// Resolve the fingerprint table against this version's block list, once per dimension.
// Kinds and variants that cannot exist in `dimension` are dropped here, so their cues
// are never searched for (no nether bricks scan in the overworld, no netherrack cue in
// the nether). A null dimension keeps all.
// → { idToName: stateId → block name (the union of every cue), entityCues: Set,
//     kinds: [{ kind, minScore, blockCues, entityCues,
//               variants: [{ name, biomes: Set|null, blockCues }] }] }
//   blockCues: [{key,w,names:Set}], entityCues: [{key,w}]. A kind without variants
//   gets a single unnamed one carrying the kind's biomes, so scoring has one shape.
let _compiled = null
function compile(mcData, dimension = null) {
  const key = `${mcData.version?.minecraftVersion || 'x'}/${dimension}`
  if (_compiled?.key === key) return _compiled
  const idToName = new Map()
  const entityCues = new Set()
  const existsHere = (x) => !dimension || !x.dimensions || x.dimensions.includes(dimension)
  const namesOf = (k) => mcData.blocksArray.filter(b => matches(k, b.name)).map(b => b.name)
  const blockCuesOf = (blocks) => Object.entries(blocks).map(([k, w]) => {
    const names = new Set(namesOf(k))
    for (const n of names) {
      const b = mcData.blocksByName[n]
      for (let id = b.minStateId; id <= b.maxStateId; id++) idToName.set(id, n)
    }
    return { key: k, w, names }
  })
  const kinds = FINGERPRINTS.filter(existsHere).map(fp => {
    for (const k of Object.keys(fp.entities)) entityCues.add(k)
    const variants = fp.variants
      ? Object.entries(fp.variants).filter(([, v]) => existsHere(v))
        .map(([name, v]) => ({ name, biomes: v.biomes ? new Set(v.biomes) : null, blockCues: blockCuesOf(v.blocks) }))
      : [{ name: null, biomes: fp.biomes ? new Set(fp.biomes) : null, blockCues: [] }]
    // every name this kind can claim, for absorbing unrecognized scraps (no scan side effect)
    const names = new Set(Object.keys(fp.entities))
    for (const blocks of [fp.blocks, ...variants.map(v => fp.variants?.[v.name]?.blocks || {})]) {
      for (const k of Object.keys(blocks)) for (const n of namesOf(k)) names.add(n)
    }
    return {
      kind: fp.kind, minScore: fp.minScore, minCues: fp.minCues ?? 2, hasVariants: !!fp.variants, variants, names,
      blockCues: blockCuesOf(fp.blocks),
      entityCues: Object.entries(fp.entities).map(([k, w]) => ({ key: k, w })),
    }
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
// center (null = unknown, no prior applied). A kind's core cues are scored once; each
// variant adds its own materials and biome prior, and the kind keeps its best variant.
function guess(members, c, biome = null) {
  const counts = new Map()
  for (const m of members) counts.set(m.name, (counts.get(m.name) || 0) + 1)
  const evidence = (count, w) => count > 0 ? w * (1 + Math.log2(Math.min(count, COUNT_SAT))) : 0
  const tally = (blockCues, entityCues = []) => {
    let score = 0, hit = 0
    const missing = []
    for (const cue of blockCues) {
      let n = 0
      for (const name of cue.names) n += counts.get(name) || 0
      if (n) { score += evidence(n, cue.w); hit++ } else missing.push(cue)
    }
    for (const cue of entityCues) {
      const n = counts.get(cue.key) || 0
      if (n) { score += evidence(n, cue.w); hit++ } else missing.push(cue)
    }
    return { score, hit, missing }
  }

  const hyps = []
  for (const k of c.kinds) {
    const core = tally(k.blockCues, k.entityCues)
    // materials only pick a variant's style; the place itself needs a core cue
    if (k.hasVariants && core.hit === 0) continue
    let best = null
    for (const v of k.variants) {
      const own = tally(v.blockCues)
      let score = core.score + own.score
      // one cue type alone is a coincidence, not a place (unless the kind says otherwise)
      if (core.hit + own.hit < k.minCues) continue
      if (biome && v.biomes && !v.biomes.has(biome)) score *= OFF_BIOME
      if (!best || score > best.score) best = { v, score, missing: [...core.missing, ...own.missing] }
    }
    if (!best || best.score < k.minScore) continue
    best.missing.sort((a, b) => b.w - a.w)
    hyps.push({ kind: k.kind, variant: best.v.name, score: best.score, missing: best.missing.slice(0, 3).map(m => m.key) })
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

// Squared distance between the nearest members of two places (edge-to-edge gap).
function gap2(a, b) {
  let best = Infinity
  for (const m of a.members) {
    for (const n of b.members) {
      const dx = m.x - n.x, dy = m.y - n.y, dz = m.z - n.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < best) best = d2
    }
  }
  return best
}

// The merged group (from mergeSameKind) within MERGE of scrap `g` whose kind claims at
// least one of g's cues, nearest first. null = g stays unrecognized.
function nearestOwner(g, groups, c) {
  let best = null, bestD2 = MERGE * MERGE
  for (const group of groups) {
    const kind = c.kinds.find(k => k.kind === group[0].hyps[0].kind)
    if (![...g.counts.keys()].some(n => kind.names.has(n))) continue
    for (const p of group) {
      const d2 = gap2(p, g)
      if (d2 <= bestD2) { bestD2 = d2; best = group }
    }
  }
  return best
}

// Union places whose top guess is the same kind and whose nearest members are within MERGE.
function mergeSameKind(places) {
  const parent = places.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      if (places[i].hyps[0].kind !== places[j].hyps[0].kind) continue
      if (gap2(places[i], places[j]) <= MERGE * MERGE) parent[find(i)] = find(j)
    }
  }
  const groups = new Map()
  for (let i = 0; i < places.length; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(places[i])
  }
  return [...groups.values()]
}

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] // +x east, +z south
const compass = (dx, dz) => COMPASS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]

// → { places: [{ at:{x,y,z}, biome, dist, dir, counts: Map, hyps: [{kind,variant,score,share,missing}] }],
//     unrecognized, unrecognizedGroups: [{ at, biome, dist, dir, counts }], candidates, losTests, visible, ms }
//   unrecognizedGroups: cue clusters no fingerprint explains — "something is there".
//   Kept rather than dropped: they are what a new fingerprint would be written from.
function recognize({ maxDistance = 48 } = {}) {
  const bot = state.bot
  if (!bot?.entity) return null
  const t0 = Date.now()
  const mcData = require('minecraft-data')(bot.version)
  const c = compile(mcData, bot.game?.dimension || null)
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const { cues, candidates, losTests } = visibleCues(eye, maxDistance, c)

  // First pass: each cluster on its own. Second pass: a village is many houses with
  // open ground between them, so places whose best guess is the same kind and whose
  // centers are close are merged, and a nearby unrecognized scrap made of that kind's
  // cues (a lone house wall, the outpost floor under the bot's feet) is absorbed; each
  // merged place is re-guessed on its pooled evidence.
  const guessed = cluster(cues).map(members => place(members))
  const merged = mergeSameKind(guessed.filter(p => p.hyps.length))
  const unrecognizedGroups = []
  for (const g of guessed.filter(p => !p.hyps.length)) {
    const home = nearestOwner(g, merged, c)
    if (home) home.push(g)
    else unrecognizedGroups.push(g)
  }
  const places = merged.map(group => group.length === 1 ? group[0] : place(group.flatMap(p => p.members)))
    .filter(p => p.hyps.length)
  for (const p of [...places, ...unrecognizedGroups]) {
    const dx = p.at.x - eye.x, dy = p.at.y - eye.y, dz = p.at.z - eye.z
    p.dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz))
    p.dir = compass(dx, dz)
  }

  function place(members) {
    const at = { x: 0, y: 0, z: 0 }
    for (const m of members) { at.x += m.x; at.y += m.y; at.z += m.z }
    for (const a of ['x', 'y', 'z']) at[a] = Math.round(at[a] / members.length)
    const biome = biomeAt(bot, mcData, at)
    const { counts, hyps } = guess(members, c, biome)
    return { at, biome, counts, hyps, members }
  }

  places.sort((a, b) => a.dist - b.dist)
  for (const p of [...places, ...unrecognizedGroups]) delete p.members
  return { places, unrecognized: unrecognizedGroups.length, unrecognizedGroups, candidates, losTests, visible: cues.length, maxDistance, ms: Date.now() - t0 }
}

function formatRecognition(r) {
  if (!r) return 'places: no bot yet'
  const head = `places r${r.maxDistance}: ${r.places.length} recognized, ${r.unrecognized} unrecognized group(s)`
  const lines = r.places.map(p => {
    const label = (h) => h.variant ? `${h.kind}(${h.variant})` : h.kind
    const guesses = p.hyps.map(h => `${label(h)} ${h.share.toFixed(2)}`).join(' | ')
    const seen = [...p.counts].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n}×${k}`).join(' ')
    const confirm = p.hyps.slice(0, 2).map(h => `${label(h)}: ${h.missing.join(', ') || '—'}`).join('; ')
    return `  ~${p.dist}m ${p.dir} @${p.at.x},${p.at.y},${p.at.z}${p.biome ? ` (${p.biome})` : ''}: ${guesses}\n    seen: ${seen}\n    would confirm → ${confirm}`
  })
  const odd = r.unrecognizedGroups.slice(0, 3).map(g =>
    `  unrecognized ~${g.dist}m ${g.dir}: ${[...g.counts].map(([n, k]) => `${n}×${k}`).join(' ')}`)
  return [head, ...lines, ...odd].join('\n')
}

// The per-turn context line — data only, how to read it lives in the system prompt.
// A confident guess is just kind + where; an unsure one adds its share, the runner-up
// and the unseen cues that would settle it. Unrecognized groups are left out: noise
// at this resolution (the debug `places` action shows them).
const SURE = 0.9, ALT = 0.15, MAX_PLACES = 4
function formatPlacesContext(r) {
  if (!r?.places.length) return ''
  const label = (h) => h.variant ? `${h.kind}(${h.variant})` : h.kind
  const items = r.places.slice(0, MAX_PLACES).map(p => {
    const [top, ...rest] = p.hyps
    let s = `${label(top)}@${p.at.x},${p.at.y},${p.at.z} ${p.dist}m ${p.dir}`
    if (top.share < SURE) {
      s += ` ${top.share.toFixed(2)}`
      const alts = rest.filter(h => h.share >= ALT).map(h => `${label(h)} ${h.share.toFixed(2)}`)
      if (alts.length) s += ` or ${alts.join(', ')}`
      if (top.missing.length) s += ` confirm:${top.missing.slice(0, 2).join(',')}`
    }
    return s
  })
  return ` PLACES=[${items.join(' | ')}]`
}

module.exports = { recognize, formatRecognition, formatPlacesContext, compile, cluster, guess }
