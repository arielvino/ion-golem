// nearby= — the mobs and drops the bot can see, nearest first. A tag, position and
// gear for every mob in loaded chunks ran to ~3k chars at night (54 mobs out to
// 159m) while the turn needed none of it. So only what is close enough to matter
// is listed one by one — a threat from farther off than a sheep — and the rest is
// one count per kind, like the fish and bats always were. Pure: entities in.
const { entityClass } = require('../perception/entityClass')
const { entityTag } = require('../perception/entityTag')
const state = require('../core/state')

// Wool colours by the low 4 bits of a sheep's `wool` metadata byte; bit 0x10 = sheared.
const WOOL_COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

// A sheep's colour, ',sheared' after it when it has no wool: a bed needs 3 of one colour.
function woolOf(e) {
  if (e.name !== 'sheep') return ''
  const idx = state.bot.registry.entitiesByName.sheep?.metadataKeys?.indexOf('wool')
  if (!(idx >= 0)) return ''
  // The server sends only metadata that differs from the default, so a plain white
  // sheep (0) arrives with no wool value at all.
  const v = e.metadata?.[idx] ?? 0
  return `,${WOOL_COLOURS[v & 15]}${v & 16 ? ',sheared' : ''}`
}

// Equipment for players and armed mobs (zombies, skeletons, piglins, etc.)
function equipOf(e) {
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

// visible: the non-player entities in sight (range- and LOS-filtered by the caller).
// ranges: { threats, mobs, drops } — how far each kind is listed by tag.
// Returns the nearby= text, the tags DELTA diffs (seen), drop stack sizes, and the
// per-kind count of threats past their range (far), so DELTA can report a crowd
// gathering without naming every member.
function renderNearby(visible, pos, ranges) {
  const seen = []
  const drops = {}  // drop tag → stack size, so DELTA can report a pile growing
  const far = {}  // threat name → count beyond ranges.threats
  // name → { n, near }; Map order is first-seen, which is nearest first.
  const farGroups = new Map()
  const background = new Map()  // fish, squid, bats: never tagged, whatever the distance
  const count = (map, e, d) => {
    // Far sheep are counted per colour (white_sheep×3): which colour has three is the
    // question. A sheared one has no wool to give, whatever its colour.
    const [, colour, sheared] = woolOf(e).split(',')
    const key = sheared ? 'sheared_sheep' : colour ? `${colour}_sheep` : e.name
    if (!map.has(key)) map.set(key, { n: 0, near: Math.round(d) })
    map.get(key).n++
  }

  const tagged = []
  const sorted = visible
    .map(e => ({ e, d: e.position.distanceTo(pos) }))
    .sort((a, b) => a.d - b.d)
  for (const { e, d } of sorted) {
    const kind = entityClass(e)
    if (kind === 'background') { count(background, e, d); continue }
    if (kind === 'drop') { if (d < ranges.drops) tagged.push({ e, d }); continue }
    if (d < (kind === 'threat' ? ranges.threats : ranges.mobs)) { tagged.push({ e, d }); continue }
    count(farGroups, e, d)
    if (kind === 'threat') far[e.name] = (far[e.name] || 0) + 1
  }

  const parts = tagged.map(({ e, d }) => {
    const tag = entityTag(e)
    const ep = e.position
    let n = ''
    if (tag.startsWith('drop:')) {
      try { drops[tag] = e.getDroppedItem().count; n = `,x${drops[tag]}` } catch (_) { /* no drop data */ }
    }
    seen.push(tag)
    return `${tag}@${Math.floor(ep.x)},${Math.floor(ep.y)},${Math.floor(ep.z)}(${Math.round(d)}m${n}${woolOf(e)}${equipOf(e)})`
  })
  const summary = (name, b) => `${name}×${b.n}(${b.near}m+)`
  for (const [name, b] of background) {
    seen.push(name)
    parts.push(summary(name, b))
  }
  // Last, so everything after "far:" is far.
  if (farGroups.size) parts.push(`far: ${[...farGroups].map(([name, b]) => summary(name, b)).join(', ')}`)
  return { text: parts.join(', ') || 'none', seen, drops, far }
}

module.exports = { renderNearby, equipOf }
