// mind.js — the model's working state of mind, carried from one turn to the next.
//
// Every turn starts from a blank conversation: the context is a single frame. NOTES are
// long-term memory (facts worth keeping), and they grow; PREV= is the last turn in one line.
// Neither carries a train of thought: a question being worked on, what was tried, what a view
// just showed. MIND= does, and it has a fixed size so it can't pile up:
//
//   [MIND:q=…; plan=…; tried=…; learned=…; next=…]
//
// A field given replaces that field; a field left out carries over; field=- clears it. The
// whole MIND is capped at MAX chars: past that, the longest fields are cut and the next turn
// says so. It is shown every turn with the goal it was written under and how many turns ago.
//
// STREAK= is the code's side: how many turns in a row the same action was started while the
// focused goal stayed the same, and over how long. A trend no single frame shows. Data only.
// Kept per world (mind.json), so it survives a restart.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')

const FIELDS = ['q', 'plan', 'tried', 'learned', 'next']
const MAX = 600
const STREAK_MIN = 3        // shown from this many repeats

let mind = null             // { fields: {q,…}, goal, turn, cut }
let loadedFor = null
let streak = null           // { sig, goal, n, since }

function file() { return state.WORLD_DATA_DIR ? path.join(state.WORLD_DATA_DIR, 'mind.json') : null }

function get() {
  if (loadedFor !== state.WORLD_DATA_DIR) {
    loadedFor = state.WORLD_DATA_DIR
    mind = null
    try { const f = file(); if (f && fs.existsSync(f)) mind = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { mind = null }
  }
  return mind
}

function save() {
  try { const f = file(); if (f) fs.writeFileSync(f, JSON.stringify(mind)) } catch (e) { console.warn('  [MIND] save err:', e.message) }
}

// "q=…; plan=…" → { q, plan }. A field runs to the next "; key=" (a ';' inside a value is fine).
function parseFields(body) {
  const out = {}
  const re = new RegExp(`(?:^|;)\\s*(${FIELDS.join('|')})\\s*=`, 'g')
  const marks = [...body.matchAll(re)].map(m => ({ key: m[1], start: m.index, end: m.index + m[0].length }))
  for (let i = 0; i < marks.length; i++) {
    const v = body.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : body.length).trim()
    out[marks[i].key] = v
  }
  return out
}

// Cut the longest fields until the whole fits MAX. → how many chars were cut.
function fit(fields) {
  const size = () => FIELDS.reduce((n, k) => n + (fields[k] ? k.length + 2 + fields[k].length : 0), 0)
  let cut = 0
  while (size() > MAX) {
    const k = FIELDS.filter(f => fields[f]).reduce((a, b) => (fields[b].length > fields[a].length ? b : a))
    const over = size() - MAX
    const keep = Math.max(20, fields[k].length - over - 1)
    cut += fields[k].length - keep
    fields[k] = fields[k].slice(0, keep).trimEnd() + '…'
    if (keep === 20) break
  }
  return cut
}

// Apply the reply's [MIND:...] (the last one, if several). → a log line or null.
function apply(reply, turn, goal) {
  const tags = [...reply.matchAll(/\[MIND:([^\]]*)\]/g)]
  if (!tags.length) return null
  const given = parseFields(tags.at(-1)[1])
  if (!Object.keys(given).length) return null
  const cur = get()?.fields || {}
  const fields = { ...cur }
  for (const [k, v] of Object.entries(given)) { if (v === '-' || v === '') delete fields[k]; else fields[k] = v }
  const cut = fit(fields)
  mind = { fields, goal, turn, cut }
  save()
  return `${Object.keys(given).join(',')}${cut ? ` (cut ${cut} chars)` : ''}`
}

// Count repeats: the actions a turn started, against the focused goal.
function noteTurn(actions, goal) {
  if (!actions.length) return
  const sig = actions.join(' → ')
  if (streak && streak.sig === sig && streak.goal === goal) streak.n++
  else streak = { sig, goal, n: 1, since: Date.now() }
}

function ago(ms) {
  const s = Math.round(ms / 1000)
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`
}

// The lines for the next turn's input: MIND= and STREAK=. '' when there is neither.
function render(turn) {
  const out = []
  const m = get()
  if (m && Object.keys(m.fields).length) {
    const body = FIELDS.filter(k => m.fields[k]).map(k => `${k}=${m.fields[k]}`).join('; ')
    const age = turn - m.turn
    out.push(`MIND${m.goal ? `@${m.goal}` : ''}(${age <= 1 ? 'last turn' : `${age} turns ago`}${m.cut ? `, ${m.cut} chars cut to fit ${MAX}` : ''})=[${body}]`)
  }
  if (streak && streak.n >= STREAK_MIN) {
    out.push(`STREAK=[${streak.sig} started ${streak.n} turns in a row over ${ago(Date.now() - streak.since)}${streak.goal ? `, goal ${streak.goal} unchanged` : ''}]`)
  }
  return out.join(' ')
}

function clear() { get(); mind = null; streak = null; save() }

module.exports = { apply, noteTurn, render, clear, parseFields, fit, MAX, FIELDS }
