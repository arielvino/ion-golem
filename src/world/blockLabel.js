// blockLabel.js — how a block is named to the model: its name plus its state, in
// Minecraft's own notation: end_portal_frame[eye=true,facing=north]. A block with
// no properties, or whose state isn't known (state NULL), is the bare name.
const { stateProps } = require('./memory')

function blockLabel(name, st, short = (n) => n) {
  const p = stateProps(st)
  const n = short(name)
  if (!p) return n
  const kv = Object.entries(p).map(([k, v]) => `${k}=${v}`)
  return kv.length ? `${n}[${kv.join(',')}]` : n
}

// The label of a live Block (stateId) or a block-memory row (state).
const labelOf = (b) => blockLabel(b.name, b.stateId ?? b.state)

// Many blocks of one name, split by state. A group keeps one entry per state id
// ({ count, nearest }), so a list grouped by name can still print every state.
function addByState(rec, st, nearest, dist) {
  if (!rec.byState) rec.byState = new Map()
  const k = st ?? null
  let s = rec.byState.get(k)
  if (!s) rec.byState.set(k, s = { count: 0, nearest: null, nearestDist: Infinity })
  s.count++
  if (dist < s.nearestDist) { s.nearestDist = dist; s.nearest = nearest }
}

// One "labelxN@x,y,z" per state of the group, nearest first. `many` (a group that
// stopped counting) prints its counts as lower bounds: x3+.
function formatByState(name, rec, short) {
  const subs = rec.byState ? [...rec.byState.entries()] : [[null, rec]]
  subs.sort((a, b) => a[1].nearestDist - b[1].nearestDist)
  return subs.map(([st, s]) => {
    const at = s.nearest, label = blockLabel(name, st, short)
    const c = rec.many ? `${s.count}+` : s.count
    return rec.many || s.count > 1 ? `${label}x${c}@${at.x},${at.y},${at.z}` : `${label}@${at.x},${at.y},${at.z}`
  })
}

module.exports = { blockLabel, labelOf, addByState, formatByState }
