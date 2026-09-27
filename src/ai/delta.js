// DELTA= — what changed since the previous turn's context. Every turn starts
// cold, so without it the model can only infer what its last move did by
// remembering the old numbers; with it, "moved 17m down, HP 19→5, +copper_pickaxe"
// is simply stated. Pure: snapshot in, one line out.

// The fields worth diffing, from values context.js already computes.
function snapshot({ pos, hp, food, held, inv, armor, vehicle, task, seen, drops = {}, players = {}, now = Date.now() }) {
  return {
    t: now,
    pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    // A running task shows its elapsed time ('bg:goto:… (13s, walking)'); drop it,
    // or the same task reads as changed every turn.
    hp: Math.round(hp), food: Math.round(food), held, task: String(task).replace(/\(\d+s,\s*/, '('), vehicle,
    inv: { ...inv }, armor: [...armor].sort(), seen: [...new Set(seen)].sort(), drops: { ...drops }, players: { ...players },
  }
}

// Smaller distance changes are walking noise and rounding.
const PLAYER_MOVE = 3

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

  // seen holds entity tags (cow#a3f9) and player names, so one cow leaving while
  // another arrives reads as both. A crowd of one kind collapses to a count.
  const came = cur.seen.filter(n => !prev.seen.includes(n))
  const went = prev.seen.filter(n => !cur.seen.includes(n))
  if (came.length) parts.push(`new nearby: ${groupTags(came)}`)
  if (went.length) parts.push(`gone from nearby: ${groupTags(went)}`)
  // A player who stays in view can still walk off; "nothing changed" while
  // Sargon went from 2m to 17m once made the bot think it was still beside him.
  const walked = Object.keys(cur.players).filter(n => n in prev.players && Math.abs(cur.players[n] - prev.players[n]) >= PLAYER_MOVE)
  if (walked.length) parts.push(walked.map(n => `${n} ${prev.players[n]}m→${cur.players[n]}m away`).join(', '))
  const grew = Object.keys(cur.drops).filter(t => t in prev.drops && prev.drops[t] !== cur.drops[t])
  if (grew.length) parts.push(grew.map(t => `${t} x${prev.drops[t]}→x${cur.drops[t]}`).join(', '))

  return parts.length ? `since last turn (${secs}s): ${parts.join(' | ')}` : `nothing changed in ${secs}s`
}

// ['cow#a3f9', 'cod#1b2c', 'cod#77d0', 'cod#9e01'] → 'cow#a3f9, cod×3'
function groupTags(tags) {
  const byBase = new Map()
  for (const t of tags) {
    const base = t.split('#')[0]
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base).push(t)
  }
  return [...byBase].map(([base, ts]) => ts.length > 2 ? `${base}×${ts.length}` : ts.join(', ')).join(', ')
}

module.exports = { snapshot, renderDelta }
