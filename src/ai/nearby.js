// nearby= — the mobs and drops the bot can see, nearest first. A tag, position and
// gear for every mob in loaded chunks ran to ~3k chars at night (54 mobs out to
// 159m) while the turn needed none of it. So only what is close enough to matter
// is listed one by one — a threat from farther off than a sheep — and the rest is
// one count per kind, like the fish and bats always were. Pure: entities in.
const { entityClass } = require('../perception/entityClass')
const { entityTag } = require('../perception/entityTag')

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
    if (!map.has(e.name)) map.set(e.name, { n: 0, near: Math.round(d) })
    map.get(e.name).n++
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
    return `${tag}@${Math.floor(ep.x)},${Math.floor(ep.y)},${Math.floor(ep.z)}(${Math.round(d)}m${n}${equipOf(e)})`
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
