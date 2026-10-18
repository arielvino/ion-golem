// Journal — the bot's episodic memory across turns (and restarts).
//
// Every turn starts from a blank conversation, so what the model remembers is
// whatever the context carries. Two layers:
//
// RECORDS (r#) — facts, written by code: action outcomes, failures, player chat.
//   Each is shown to the model ONCE, in NEW=, the turn after it happens.
// NOTES (n#) — the model's running story, written with [NOTE:...]. Notes name
//   what they rest on ("south floods at y52 [r41,r43,slice]"): record ids are
//   citations — checked and kept alive — and anything else (a tool, a context
//   field, another note) is kept verbatim as a source. Notes are shown every
//   turn, and can be merged or updated with [NOTE:compact:n3-n9:...] (or
//   [NOTE:replace:n5:...]) and deleted with [NOTE:drop:n3,n7]. A compacted note
//   inherits every citation of the notes it replaces, so the story can shrink
//   without losing its grounding. An uncited note is visibly an inference.
//   A note with tags ("{bed,home} my bed at …") is SHELVED: not shown every turn,
//   only its tags in the SHELF= index, and read back on demand by tag — so the
//   bot can remember a lot without paying for all of it on every turn.
//
// Records nobody cites fall out of the context after one showing but stay here
// (up to MAX_RECORDS) and in the event DB — suppressed, not discarded. Cited
// records are never evicted, so a citation always resolves.
//
// Pure data + operations; persistence via toJSON/fromJSON.

const MAX_RECORDS = 500
const NEW_SHOWN = 25   // most recent new records shown per turn; older ones summarized
const MAX_LOOKUP = 50
const BASIS_SHOWN = 6    // basis items shown per note; the rest are summarized
const SHELF_TAGS_SHOWN = 40   // tags listed in SHELF=; the rest are summarized
// Context fields that show live status every turn. A note resting on one is
// status — it goes stale within minutes — so it is not kept as a source.
const STATUS_SOURCES = new Set(['inv', 'armor', 'held', 'offhand', 'pos', 'hp', 'food', 'task', 'nav', 'queue', 'nearby', 'players'])
const isStatusSource = (src) => STATUS_SOURCES.has(String(src).replace(/=$/, '').toLowerCase())

// The live-status fields a note's trailing basis names ("… [r41,inv,armor]" → inv,armor).
function statusBasis(text) {
  const m = /\[([^[\]]+)\]\s*$/.exec(String(text || ''))
  return m ? m[1].split(',').map(s => s.trim()).filter(isStatusSource) : []
}

// A duration as a person would say it: 40s, 7m, 2h05m, 3d4h.
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

class JournalError extends Error {}

class Journal {
  constructor() {
    this.records = []   // { id, ts, text }
    this.notes = []     // { id, ts, text, cites: [r#], sources: [other basis], node, tags: [] }
    this.rseq = 0
    this.nseq = 0
    this.cursor = 0     // records with number <= cursor have been shown
  }

  // ---- records (code) ----

  record(text, ts = Date.now()) {
    const r = { id: `r${++this.rseq}`, ts, text: String(text) }
    this.records.push(r)
    this._evict()
    return r
  }

  // Records not yet shown, oldest first.
  unseen() { return this.records.filter(r => num(r.id) > this.cursor) }

  // Mark everything up to `upTo` (a record number) as shown. Called after the
  // model actually got a reply out, so an aborted turn doesn't swallow records.
  markShown(upTo) { if (upTo > this.cursor) this.cursor = upTo }

  // ---- notes (model) ----

  // tags: the shelf tags (see splitTags); none means the note is shown every turn.
  note(text, node, tags = []) {
    const { body, cites, sources } = this._parseCites(text)
    if (!body) throw new JournalError('empty note')
    const n = { id: `n${++this.nseq}`, ts: Date.now(), text: body, cites, sources: this._liveSources(sources), node: node || null, tags }
    this.notes.push(n)
    return n
  }

  // Replace notes (by id: "n5", a range "n3-n9", or a list "n3,n7,n10-n12") with
  // a single note, placed where the first of them stood. Citations of the
  // replaced notes carry over automatically. One id is a plain update: the old
  // version goes, the new one takes its place under a new id. With tags undefined
  // the new note keeps every tag of the notes it replaces; [] takes it off the shelf.
  compact(spec, text, node, tags) {
    const ids = parseIds(spec)
    const i = this.notes.findIndex(n => ids.has(num(n.id)))
    const run = this.notes.filter(n => ids.has(num(n.id)))
    if (run.length === 0) throw new JournalError(`no notes in ${spec}`)
    const { body, cites, sources } = this._parseCites(text)
    if (!body) throw new JournalError('empty compacted note')
    const inherited = run.flatMap(n => n.cites)
    const all = [...new Set([...inherited, ...cites])].sort((a, b) => num(a) - num(b))
    const allSources = [...new Set([...run.flatMap(n => n.sources || []), ...sources])]
    this.notes = this.notes.filter(x => !run.includes(x))
    // A merged note absorbs the notes it replaces, so references to them go too.
    const allTags = tags ?? [...new Set(run.flatMap(n => n.tags || []))]
    const n = { id: `n${++this.nseq}`, ts: Date.now(), text: body, cites: all, sources: this._liveSources(allSources), node: node || null, tags: allTags }
    this.notes.splice(i, 0, n)
    return { note: n, replaced: run.map(x => x.id) }
  }

  // Delete notes outright (same id forms as compact). Their citations go with
  // them, so the records they protected may be evicted again.
  drop(spec) {
    const ids = parseIds(spec)
    const gone = this.notes.filter(n => ids.has(num(n.id)))
    if (gone.length === 0) throw new JournalError(`no notes in ${spec}`)
    this.notes = this.notes.filter(n => !gone.includes(n))
    return gone.map(n => n.id)
  }

  // Records by id, for the read_records tool: "r23-r25,r34". Ids no longer kept
  // come back without text, so the caller can say so instead of guessing.
  lookup(spec) {
    const ids = []
    for (const tok of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
      const m = /^r(\d+)(?:-r?(\d+))?$/.exec(tok)
      if (!m) throw new JournalError(`bad record id "${tok}" — use r23 or r23-r25`)
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ids.push(i)
      if (ids.length > MAX_LOOKUP) throw new JournalError(`at most ${MAX_LOOKUP} records per lookup`)
    }
    const byId = new Map(this.records.map(r => [r.id, r]))
    return [...new Set(ids)].sort((x, y) => x - y).map(i => byId.get(`r${i}`) || { id: `r${i}` })
  }

  // ---- views ----

  // One-line NEW= body, or '' when nothing is new. Consecutive identical records
  // collapse ("r41-r43 ×3 staircase:south failed").
  renderNew() {
    const fresh = this.unseen()
    if (fresh.length === 0) return ''
    const shown = fresh.slice(-NEW_SHOWN)
    const parts = []
    for (let i = 0; i < shown.length;) {
      let j = i
      while (j + 1 < shown.length && shown[j + 1].text === shown[i].text) j++
      const id = j > i ? `${shown[i].id}-${shown[j].id} ×${j - i + 1}` : shown[i].id
      parts.push(`${id} ${shown[i].text}`)
      i = j + 1
    }
    const skipped = fresh.length - shown.length
    return (skipped > 0 ? `(+${skipped} older) ` : '') + parts.join(' | ')
  }

  // Multi-line NOTES block, or '' with no notes.
  // nodeLabel turns a note's node id into its shown form (e.g. 'g2(done 1m ago)').
  // Shelved notes are left out; renderShelf lists their tags instead.
  renderNotes(compactHint = 20, now = Date.now(), nodeLabel = id => id) {
    const live = this.notes.filter(n => !n.tags?.length)
    if (live.length === 0) return ''
    const lines = [`NOTES (${live.length})${live.length >= compactHint ? ' ← long: drop or merge what future turns no longer need' : ''}:`]
    for (const n of live) lines.push(this._noteLine(n, now, nodeLabel))
    return lines.join('\n')
  }

  // One-line SHELF= index of the shelved notes' tags, most used first, or ''.
  renderShelf() {
    const count = new Map()
    for (const n of this.notes) for (const t of n.tags || []) count.set(t, (count.get(t) || 0) + 1)
    if (count.size === 0) return ''
    const tags = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const shown = tags.slice(0, SHELF_TAGS_SHOWN).map(([t, k]) => `${t}:${k}`).join(' ')
    const more = tags.length > SHELF_TAGS_SHOWN ? ` +${tags.length - SHELF_TAGS_SHOWN} more tags` : ''
    return `SHELF=[${this.notes.filter(n => n.tags?.length).length} notes | ${shown}${more}]`
  }

  // Shelved notes carrying any of `tags` (all shelved notes when empty), as lines.
  shelved(tags = [], now = Date.now(), nodeLabel = id => id) {
    const want = new Set(tags)
    return this.notes
      .filter(n => n.tags?.length && (want.size === 0 || n.tags.some(t => want.has(t))))
      .map(n => this._noteLine(n, now, nodeLabel))
  }

  _noteLine(n, now, nodeLabel) {
    const tags = n.tags?.length ? ` {${n.tags.join(',')}}` : ''
    const at = n.node ? ` @${nodeLabel(n.node)}` : ''
    // The full basis stays stored (cited records stay protected); the view
    // shows the first few so one long-compacted note can't flood every turn.
    const basis = [...n.cites, ...(n.sources || [])]
    const shown = basis.length > BASIS_SHOWN ? `${basis.slice(0, BASIS_SHOWN).join(',')} +${basis.length - BASIS_SHOWN} more` : basis.join(',')
    const cite = basis.length ? ` [${shown}]` : ''
    return `${n.id}${tags}${at} (${ago(now - n.ts)} ago) ${n.text}${cite}`
  }

  // ---- persistence ----

  toJSON() {
    return { records: this.records, notes: this.notes, rseq: this.rseq, nseq: this.nseq, cursor: this.cursor }
  }

  static fromJSON(data) {
    const j = new Journal()
    if (!data) return j
    j.records = data.records || []
    j.notes = data.notes || []
    // Notes saved before sources existed kept a mixed basis ("[r36,slice]") in
    // their text, uncited. Re-parse them once; a bad basis stays as text.
    for (const n of j.notes) {
      if (n.sources) continue
      try { Object.assign(n, j._reparse(n)) } catch { n.sources = [] }
    }
    for (const n of j.notes) n.sources = j._liveSources(n.sources)
    j.rseq = data.rseq || 0
    j.nseq = data.nseq || 0
    j.cursor = data.cursor || 0
    return j
  }

  // ---- internals ----

  // The basis is a trailing [...] ("text [r41,r43,slice]"). Its r# tokens are
  // citations, and every cited record must exist; the rest are sources.
  _parseCites(text) {
    let body = String(text || '').trim()
    let basis = []
    const m = /\s*\[([^[\]]+)\]\s*$/.exec(body)
    if (m) {
      basis = [...new Set(m[1].split(',').map(s => s.trim()).filter(Boolean))]
      body = body.slice(0, m.index).trim()
    }
    const cites = basis.filter(t => /^r\d+$/.test(t))
    const sources = basis.filter(t => !/^r\d+$/.test(t))
    const known = new Set(this.records.map(r => r.id))
    const missing = cites.filter(c => !known.has(c))
    if (missing.length) throw new JournalError(`unknown record(s) ${missing.join(',')} — cite ids from NEW=`)
    return { body, cites, sources }
  }

  // Drop references to notes that no longer exist ("n8", "n3-n9") and live-status
  // fields (see STATUS_SOURCES); keep the rest.
  _liveSources(sources) {
    const live = new Set(this.notes.map(n => num(n.id)))
    return sources.filter(src => {
      if (isStatusSource(src)) return false
      const m = /^n(\d+)(?:-n?(\d+))?$/.exec(src)
      if (!m) return true
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (live.has(i)) return true
      return false
    })
  }

  _reparse(n) {
    const { body, cites, sources } = this._parseCites(n.text)
    return { text: body, cites: [...new Set([...n.cites, ...cites])], sources }
  }

  _evict() {
    if (this.records.length <= MAX_RECORDS) return
    const cited = new Set(this.notes.flatMap(n => n.cites))
    let excess = this.records.length - MAX_RECORDS
    this.records = this.records.filter(r => {
      if (excess > 0 && !cited.has(r.id) && num(r.id) <= this.cursor) { excess--; return false }
      return true
    })
  }
}

function num(id) { return Number(String(id).slice(1)) }

// A leading "{bed,home base}" → { tags: ['bed', 'home_base'], text: rest }.
// tags is undefined when the text has no braces, and [] for an empty "{}".
function splitTags(text) {
  const m = /^\s*\{([^{}]*)\}\s*/.exec(String(text || ''))
  if (!m) return { tags: undefined, text: String(text || '') }
  const tags = [...new Set(m[1].split(',')
    .map(t => t.trim().toLowerCase().replace(/^#/, '').replace(/[\s:]+/g, '_'))
    .filter(Boolean))]
  return { tags, text: String(text).slice(m[0].length) }
}

// "n5", "n3-n9", "n3,n7,n10-n12" → the set of note numbers.
function parseIds(spec) {
  const ids = new Set()
  for (const tok of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^n(\d+)(?:-n?(\d+))?$/.exec(tok)
    if (!m) throw new JournalError(`bad note id "${tok}" — use n5, n3-n9 or n3,n7`)
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ids.add(i)
  }
  if (ids.size === 0) throw new JournalError(`bad note ids "${spec}" — use n5, n3-n9 or n3,n7`)
  return ids
}

module.exports = { Journal, JournalError, MAX_RECORDS, ago, splitTags, statusBasis }
