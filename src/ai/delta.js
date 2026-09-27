// DELTA= — what changed since the previous turn's context. Every turn starts
// cold, so without it the model can only infer what its last move did by
// remembering the old numbers; with it, "moved 17m down, HP 19→5, +copper_pickaxe"
// is simply stated. Pure: snapshot in, one line out.

// The fields worth diffing, from values context.js already computes.
function snapshot({ pos, hp, food, held, inv, armor, vehicle, task, seen, now = Date.now() }) {
  return {
    t: now,
    pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    // A running task shows its elapsed time ('bg:goto:… (13s, walking)'); drop it,
    // or the same task reads as changed every turn.
    hp: Math.round(hp), food: Math.round(food), held, task: String(task).replace(/\(\d+s,\s*/, '('), vehicle,
    inv: { ...inv }, armor: [...armor].sort(), seen: [...new Set(seen)].sort(),
  }
}

function renderDelta(prev, cur) {
  if (!prev) return ''
  const secs = Math.max(0, Math.round((cur.t - prev.t) / 1000))
  const parts = []

  const { x, y, z } = cur.pos, p = prev.pos
  if (x !== p.x || y !== p.y || z !== p.z) {
    const d = Math.round(Math.hypot(x - p.x, y - p.y, z - p.z))
    const dy = y - p.y
    parts.push(`moved ${p.x},${p.y},${p.z}→${x},${y},${z} (${d}m${dy ? `, ${dy > 0 ? '+' : ''}${dy}y` : ''})`)
  }
  if (cur.hp !== prev.hp) parts.push(`HP ${prev.hp}→${cur.hp}`)
  if (cur.food !== prev.food) parts.push(`food ${prev.food}→${cur.food}`)

  const items = []
  for (const name of new Set([...Object.keys(prev.inv), ...Object.keys(cur.inv)])) {
    const diff = (cur.inv[name] || 0) - (prev.inv[name] || 0)
    if (diff) items.push(`${diff > 0 ? '+' : ''}${diff} ${name}`)
  }
  if (items.length) parts.push(items.join(', '))

  if (cur.held !== prev.held) parts.push(`held ${prev.held}→${cur.held}`)
  if (cur.armor.join() !== prev.armor.join()) parts.push(`armor [${prev.armor.join(',') || 'none'}]→[${cur.armor.join(',') || 'none'}]`)
  if (cur.vehicle !== prev.vehicle) parts.push(`${prev.vehicle}→${cur.vehicle}`)
  if (cur.task !== prev.task) parts.push(`task ${prev.task}→${cur.task}`)

  const came = cur.seen.filter(n => !prev.seen.includes(n))
  const went = prev.seen.filter(n => !cur.seen.includes(n))
  if (came.length) parts.push(`in view: ${came.join(', ')}`)
  if (went.length) parts.push(`out of view: ${went.join(', ')}`)

  return parts.length ? `since last turn (${secs}s): ${parts.join(' | ')}` : `nothing changed in ${secs}s`
}

module.exports = { snapshot, renderDelta }
