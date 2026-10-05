// ctxPast.js — [CTX:...] views of the bot's PAST: what it built, said, did and
// recorded. They answer from the event DB and the journal, in-process, and like
// every other view they arrive in the NEXT turn's context, once.
//
// These used to be MCP tools the model called mid-reply. An in-turn tool always
// beats a next-turn channel, so the model spent whole turns in query sprees
// instead of acting; as views they ride alongside an action instead.
//
// Output is one compact line per row, capped — a view is read once, in a context
// that already carries everything else.
const state = require('../core/state')
const { parseBlueprint } = require('../lib/blueprint')

const MAX_ROWS = 40

const intArg = (v, def) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}
const isInt = (v) => /^-?\d+$/.test(String(v ?? ''))
const clampLimit = (v, def) => Math.max(1, Math.min(MAX_ROWS, intArg(v, def)))

function parseXYZ(s) {
  const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(String(s ?? ''))
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null
}

function botPos() {
  const p = state.bot?.entity?.position
  if (!p) throw new Error('bot position unknown')
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

// game_tick = world age in ticks (20/s); timeOfDay 0 = 06:00. e.g. "day3 06:00".
function gameTime(tick, day) {
  const tod = tick % 24000
  const hour = Math.floor((tod / 1000 + 6) % 24)
  const minute = Math.floor(((tod % 1000) / 1000) * 60)
  return `day${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// Statements are prepared lazily against the bot's own connection (state.db).
const cache = new Map()
function stmt(sql) {
  if (!state.db) throw new Error('block DB not open')
  let s = cache.get(sql)
  if (!s || s.database !== state.db) { s = state.db.prepare(sql); cache.set(sql, s) }
  return s
}

const EVENT_COLS = 'game_tick, game_day, type, target, count, x, y, z, detail'
function eventLine(r) {
  const at = r.x != null ? ` @${r.x},${r.y},${r.z}` : ''
  const n = r.count > 1 ? ` ×${r.count}` : ''
  return `${gameTime(r.game_tick, r.game_day)} ${r.type} ${r.target}${n}${at}${detailText(r.detail)}`
}
// {"tool":"hand","reason":"navigation"} -> " tool=hand reason=navigation"
function detailText(detail) {
  if (!detail) return ''
  try {
    const d = JSON.parse(detail)
    if (d && typeof d === 'object') {
      return ' ' + Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
    }
  } catch { /* plain text */ }
  return ` ${detail}`
}
function chatLine(r) {
  return `${gameTime(r.game_tick, r.game_day)} ${r.type}${r.username ? ` <${r.username}>` : ''} ${r.message}`
}
function block(title, lines, empty) {
  return lines.length ? `${title}\n${lines.join('\n')}` : `${title}\n${empty}`
}

// ── journal ──────────────────────────────────────────────────────────────
function records(args) {
  if (!state.journal) throw new Error('journal not loaded')
  if (!args[0]) throw new Error('give ids, e.g. records:r23-r25,r34')
  const rows = state.journal.lookup(args[0])
  return block(`records ${args[0]}:`, rows.map(r => r.text == null
    ? `${r.id} (no longer kept — nothing cited it)`
    : `${r.id} ${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')} ${r.text}`), '')
}

// ── builds ───────────────────────────────────────────────────────────────
function structures() {
  const rows = stmt(`SELECT s.id, s.name, s.blueprint IS NOT NULL AS bp, s.origin_x, s.origin_y, s.origin_z,
      MIN(p.x) x1, MAX(p.x) x2, MIN(p.y) y1, MAX(p.y) y2, MIN(p.z) z1, MAX(p.z) z2, COUNT(p.x) n
    FROM structures s LEFT JOIN placed_blocks p ON p.structure_id = s.id
    WHERE s.dim = cur_dim() GROUP BY s.id ORDER BY s.created_at DESC`).all()
  return block('structures (newest first):', rows.slice(0, MAX_ROWS).map(s => {
    const origin = s.origin_x != null ? ` origin=${s.origin_x},${s.origin_y},${s.origin_z}` : ''
    const box = s.x1 != null ? ` box=${s.x1},${s.y1},${s.z1}..${s.x2},${s.y2},${s.z2}` : ''
    return `#${s.id} ${s.name}${origin}${box} blocks=${s.n}${s.bp ? ' blueprint' : ''}`
  }), 'none built yet')
}

function structure(args) {
  const id = intArg(args[0], NaN)
  if (!Number.isFinite(id)) throw new Error('give a structure id, e.g. structure:3 (ids from [CTX:structures])')
  const s = stmt('SELECT id, name, blueprint, origin_x, origin_y, origin_z FROM structures WHERE id = ?').get(id)
  if (!s) return `structure #${id}: no such structure`
  const placed = stmt('SELECT bp_x, bp_y, bp_z FROM placed_blocks WHERE structure_id = ?').all(id)
  const head = `structure #${s.id} ${s.name}${s.origin_x != null ? ` origin=${s.origin_x},${s.origin_y},${s.origin_z}` : ''} placed=${placed.length}`
  let parsed = null
  try { parsed = s.blueprint ? parseBlueprint(s.blueprint) : null } catch { /* unreadable blueprint */ }
  if (!parsed) return `${head} (no blueprint — completion unknown)`
  const have = new Set(placed.map(r => `${r.bp_x},${r.bp_y},${r.bp_z}`))
  const missing = parsed.blocks.filter(b => !have.has(`${b.x},${b.y},${b.z}`))
  const pct = Math.round((parsed.blocks.length - missing.length) / parsed.blocks.length * 100)
  const at = (b) => s.origin_x != null ? `@${s.origin_x + b.x},${s.origin_y + b.y},${s.origin_z + b.z}` : `@bp${b.x},${b.y},${b.z}`
  const lines = missing.slice(0, MAX_ROWS).map(b => `${b.block}${at(b)}`)
  if (missing.length > MAX_ROWS) lines.push(`(+${missing.length - MAX_ROWS} more)`)
  return block(`${head}/${parsed.blocks.length} (${pct}%) — missing ${missing.length}:`, lines, 'nothing — complete')
}

// ── biomes ───────────────────────────────────────────────────────────────
function biomes() {
  const rows = stmt(`SELECT biome, COUNT(*) n, MIN(chunk_x) x1, MAX(chunk_x) x2, MIN(chunk_y) y1, MAX(chunk_y) y2,
      MIN(chunk_z) z1, MAX(chunk_z) z2 FROM chunk_biomes WHERE dim = cur_dim() GROUP BY biome ORDER BY n DESC`).all()
  return block('biomes explored (16³ sections; block ranges):', rows.slice(0, MAX_ROWS).map(r =>
    `${r.biome} ×${r.n} x${r.x1 * 16}..${r.x2 * 16 + 15} y${r.y1 * 16}..${r.y2 * 16 + 15} z${r.z1 * 16}..${r.z2 * 16 + 15}`),
  'none explored yet')
}

function biome(args) {
  const name = args[0]
  if (!name) throw new Error('give a biome name, e.g. biome:desert')
  const p = botPos()
  const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16)
  const rows = stmt(`SELECT chunk_x, chunk_y, chunk_z FROM chunk_biomes WHERE dim = cur_dim() AND biome LIKE ?
    ORDER BY (chunk_x - ?) * (chunk_x - ?) + (chunk_z - ?) * (chunk_z - ?) ASC LIMIT ?`)
    .all(`%${name}%`, cx, cx, cz, cz, clampLimit(args[1], 5))
  return block(`nearest explored "${name}" sections (centers):`, rows.map(r => {
    const d = Math.round(Math.hypot(r.chunk_x - cx, r.chunk_z - cz) * 16)
    return `${r.chunk_x * 16 + 8},${r.chunk_y * 16 + 8},${r.chunk_z * 16 + 8} (${d}m)`
  }), 'not seen yet — explore to find it')
}

// ── containers ───────────────────────────────────────────────────────────
function container(args) {
  const c = parseXYZ(args[0])
  if (!c) throw new Error('give coords, e.g. container:12,64,-30')
  const row = stmt('SELECT type, contents, updated_at FROM containers WHERE dim = cur_dim() AND x=? AND y=? AND z=?').get(c.x, c.y, c.z)
  if (!row) return `container ${c.x},${c.y},${c.z}: never opened`
  let items
  try { items = JSON.parse(row.contents) } catch { return `${row.type} ${c.x},${c.y},${c.z}: ${row.contents}` }
  const list = Array.isArray(items) ? items
    : [items.input, items.fuel, items.output, ...(items.items || [])].filter(Boolean)
  const body = list.filter(i => i?.name).map(i => `${i.name}×${i.count || 1}`).join(', ') || 'empty'
  const when = new Date(row.updated_at).toISOString().slice(0, 16).replace('T', ' ')
  return `${row.type} ${c.x},${c.y},${c.z} (as last opened, ${when}): ${body}`
}

// ── chat ─────────────────────────────────────────────────────────────────
const CHAT_COLS = 'game_tick, game_day, type, username, message'
function chat(args) {
  // chat[:limit] or chat:<username>[:limit]
  const user = args[0] && !isInt(args[0]) ? args[0] : null
  const limit = clampLimit(user ? args[1] : args[0], 20)
  const rows = user
    ? stmt(`SELECT ${CHAT_COLS} FROM chat_log WHERE username = ? ORDER BY game_tick DESC LIMIT ?`).all(user, limit)
    : stmt(`SELECT ${CHAT_COLS} FROM chat_log ORDER BY game_tick DESC LIMIT ?`).all(limit)
  return block(`chat${user ? ` from ${user}` : ''} (oldest first):`, rows.reverse().map(chatLine), 'none')
}

function chatsearch(args) {
  if (!args[0]) throw new Error('give a search term, e.g. chatsearch:diamond')
  const rows = stmt(`SELECT ${CHAT_COLS} FROM chat_log WHERE message LIKE ? ORDER BY game_tick DESC LIMIT ?`)
    .all(`%${args[0]}%`, clampLimit(args[1], 20))
  return block(`chat matching "${args[0]}" (oldest first):`, rows.reverse().map(chatLine), 'none')
}

// ── events ───────────────────────────────────────────────────────────────
function events(args) {
  // events[:limit] or events:<type>[:limit]
  const type = args[0] && !isInt(args[0]) ? args[0] : null
  const limit = clampLimit(type ? args[1] : args[0], 20)
  const rows = type
    ? stmt(`SELECT ${EVENT_COLS} FROM events WHERE type = ? ORDER BY game_tick DESC LIMIT ?`).all(type, limit)
    : stmt(`SELECT ${EVENT_COLS} FROM events ORDER BY game_tick DESC LIMIT ?`).all(limit)
  return block(`recent events${type ? ` (${type})` : ''} (oldest first):`, rows.reverse().map(eventLine), 'none')
}

function eventsearch(args) {
  if (!args[0]) throw new Error('give a name, e.g. eventsearch:diamond or eventsearch:iron:mine')
  const [pat, type] = args
  const rows = type
    ? stmt(`SELECT ${EVENT_COLS} FROM events WHERE target LIKE ? AND type = ? ORDER BY game_tick DESC LIMIT ?`).all(`%${pat}%`, type, MAX_ROWS)
    : stmt(`SELECT ${EVENT_COLS} FROM events WHERE target LIKE ? ORDER BY game_tick DESC LIMIT ?`).all(`%${pat}%`, MAX_ROWS)
  return block(`events involving "${pat}"${type ? ` (${type})` : ''} (oldest first):`, rows.reverse().map(eventLine), 'none')
}

function stats(args) {
  const type = args[0] || null
  const rows = type
    ? stmt('SELECT type, target, SUM(count) total FROM events WHERE type = ? GROUP BY target ORDER BY total DESC').all(type)
    : stmt('SELECT type, target, SUM(count) total FROM events GROUP BY type, target ORDER BY type, total DESC').all()
  const byType = new Map()
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, [])
    byType.get(r.type).push(`${r.target}×${r.total}`)
  }
  return block(`event totals${type ? ` (${type})` : ''}:`, [...byType].map(([t, xs]) => `${t}: ${xs.join(', ')}`), 'none')
}

function near(args) {
  // near[:x,y,z][:radius][:type] — centre defaults to where the bot stands.
  const rest = [...args]
  const at = parseXYZ(rest[0]) ? parseXYZ(rest.shift()) : botPos()
  const r = isInt(rest[0]) ? Math.max(1, Math.min(64, intArg(rest.shift(), 16))) : 16
  const type = rest[0] || null
  let rows = stmt(`SELECT ${EVENT_COLS} FROM events WHERE x IS NOT NULL AND dim = cur_dim()
      AND (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) < ? ORDER BY game_tick DESC LIMIT ?`)
    .all(at.x, at.x, at.y, at.y, at.z, at.z, r * r, type ? 500 : MAX_ROWS)
  if (type) rows = rows.filter(e => e.type === type).slice(0, MAX_ROWS)
  return block(`events within ${r}m of ${at.x},${at.y},${at.z}${type ? ` (${type})` : ''} (oldest first):`,
    rows.reverse().map(eventLine), 'none — nothing happened here')
}

// ── agenda history ───────────────────────────────────────────────────────
function tasks(args) {
  const q = args[0] || null
  const cols = 'game_tick, game_day, action, task, detail'
  const rows = q
    ? stmt(`SELECT ${cols} FROM task_log WHERE task LIKE ? OR detail LIKE ? OR stack_after LIKE ? ORDER BY game_tick DESC LIMIT ?`)
      .all(`%${q}%`, `%${q}%`, `%${q}%`, 20)
    : stmt(`SELECT ${cols} FROM task_log ORDER BY game_tick DESC LIMIT ?`).all(20)
  return block(`agenda edits${q ? ` matching "${q}"` : ''} (oldest first):`, rows.reverse().map(r =>
    `${gameTime(r.game_tick, r.game_day)} ${r.action}${r.task ? ` ${r.task}` : ''}${r.detail ? ` — ${r.detail}` : ''}`), 'none')
}

const PAST_PROVIDERS = {
  records:     { usage: 'records:<ids>             full text of journal records, e.g. records:r23-r25,r34', render: records },
  structures:  { usage: 'structures                what you have built: id, location, size', render: structures },
  structure:   { usage: 'structure:<id>            one build: completion % and the blocks still missing', render: structure },
  biomes:      { usage: 'biomes                    every biome explored, with its block ranges', render: biomes },
  biome:       { usage: 'biome:<name>[:limit]      nearest explored sections of a biome, from where you stand', render: biome },
  container:   { usage: 'container:<x,y,z>         what a chest/barrel/furnace held when you last opened it', render: container },
  chat:        { usage: 'chat[:<player>][:limit]   recent chat, optionally one player\'s', render: chat },
  chatsearch:  { usage: 'chatsearch:<text>         every chat line containing text', render: chatsearch },
  events:      { usage: 'events[:<type>][:limit]   recent game events (mine, place, kill, craft, smelt, pickup, give, death...)', render: events },
  eventsearch: { usage: 'eventsearch:<name>[:type] everything that happened involving a block/item/mob', render: eventsearch },
  stats:       { usage: 'stats[:<type>]            totals: mined by block, killed by mob, crafted...', render: stats },
  near:        { usage: 'near[:x,y,z][:radius][:type]  events near a spot (default: here, 16m)', render: near },
  tasks:       { usage: 'tasks[:<text>]            history of agenda edits — why a goal was dropped', render: tasks },
}

module.exports = { PAST_PROVIDERS, gameTime }
