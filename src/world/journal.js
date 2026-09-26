// Journal — the bot's episodic memory across turns (and restarts).
//
// Every turn starts from a blank conversation, so what the model remembers is
// whatever the context carries. Two layers:
//
// RECORDS (r#) — facts, written by code: action outcomes, failures, player chat.
//   Each is shown to the model ONCE, in NEW=, the turn after it happens.
// NOTES (n#) — the model's running story, written with [NOTE:...]. Notes cite
//   the records they rest on ("south floods at y52 [r41,r43]"), are shown every
//   turn, and can be merged with [NOTE:compact:n3-n9:...]. A compacted note
//   inherits every citation of the notes it replaces, so the story can shrink
//   without losing its grounding. An uncited note is visibly an inference.
//
// Records nobody cites fall out of the context after one showing but stay here
// (up to MAX_RECORDS) and in the event DB — suppressed, not discarded. Cited
// records are never evicted, so a citation always resolves.
//
// Pure data + operations; persistence via toJSON/fromJSON.

const MAX_RECORDS = 500
const NEW_SHOWN = 25   // most recent new records shown per turn; older ones summarized

class JournalError extends Error {}

class Journal {
  constructor() {
    this.records = []   // { id, ts, text }
    this.notes = []     // { id, ts, text, cites: [r#], node }
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

  note(text, node) {
    const { body, cites } = this._parseCites(text)
    if (!body) throw new JournalError('empty note')
    const n = { id: `n${++this.nseq}`, ts: Date.now(), text: body, cites, node: node || null }
    this.notes.push(n)
    return n
  }

  // Replace a contiguous run of notes (by id range, "n3-n9", or one id) with a
  // single note. Citations of the replaced notes carry over automatically.
  compact(range, text, node) {
    const [from, to] = parseRange(range)
    const i = this.notes.findIndex(n => num(n.id) >= from)
    const run = this.notes.filter(n => num(n.id) >= from && num(n.id) <= to)
    if (run.length === 0) throw new JournalError(`no notes in ${range}`)
    const { body, cites } = this._parseCites(text)
    if (!body) throw new JournalError('empty compacted note')
    const inherited = run.flatMap(n => n.cites)
    const all = [...new Set([...inherited, ...cites])].sort((a, b) => num(a) - num(b))
    const n = { id: `n${++this.nseq}`, ts: Date.now(), text: body, cites: all, node: node || null }
    this.notes = this.notes.filter(x => !run.includes(x))
    this.notes.splice(i, 0, n)
    return { note: n, replaced: run.map(x => x.id) }
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
  renderNotes(compactHint = 20) {
    if (this.notes.length === 0) return ''
    const lines = [`NOTES (${this.notes.length})${this.notes.length >= compactHint ? ' ← long: consider [NOTE:compact:...]' : ''}:`]
    for (const n of this.notes) {
      const at = n.node ? ` @${n.node}` : ''
      const cite = n.cites.length ? ` [${n.cites.join(',')}]` : ''
      lines.push(`${n.id}${at} ${n.text}${cite}`)
    }
    return lines.join('\n')
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
    j.rseq = data.rseq || 0
    j.nseq = data.nseq || 0
    j.cursor = data.cursor || 0
    return j
  }

  // ---- internals ----

  // Citations are r# tokens inside a trailing [...] ("text [r41,r43]") — the
  // form the prompt asks for. Every cited record must exist.
  _parseCites(text) {
    let body = String(text || '').trim()
    let cites = []
    const m = /\s*\[((?:\s*r\d+\s*,?)+)\]\s*$/.exec(body)
    if (m) {
      cites = m[1].split(',').map(s => s.trim()).filter(Boolean)
      body = body.slice(0, m.index).trim()
    }
    const known = new Set(this.records.map(r => r.id))
    const missing = cites.filter(c => !known.has(c))
    if (missing.length) throw new JournalError(`unknown record(s) ${missing.join(',')} — cite ids from NEW=`)
    return { body, cites: [...new Set(cites)] }
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

function parseRange(range) {
  const m = /^n(\d+)(?:-n?(\d+))?$/.exec(String(range).trim())
  if (!m) throw new JournalError(`bad range "${range}" — use n3-n9 or n5`)
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
  return a <= b ? [a, b] : [b, a]
}

module.exports = { Journal, JournalError, MAX_RECORDS }
