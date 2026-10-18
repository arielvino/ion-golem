// TALK= — the recent conversation with players, carried across turns.
//
// A player's message is a record, and a record is shown once (NEW=). The turn
// after, the model no longer knew what had been said or what it had done about
// it: asked "did you do what I asked about the notes?" five turns after cleaning
// them, it answered "which notes?". So each player line stays in view for a
// while, with the reply it got and what that reply set in motion.
const { ago } = require('../world/journal')

const KEEP_MS = 15 * 60 * 1000   // a line leaves the view this long after it was said
const MAX_LINES = 8
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// A conversation: lines heard, each answered by the first turn that completes after it.
class Talk {
  constructor() { this.lines = [] }

  heard(who, text, ts = Date.now()) {
    this.lines.push({ ts, who, text: String(text), reply: null })
    if (this.lines.length > MAX_LINES * 2) this.lines.splice(0, this.lines.length - MAX_LINES * 2)
  }

  // A turn finished: its reply answers every line still waiting.
  answered({ said = '', actions = [], plan = [], notes = [] }) {
    for (const l of this.lines) if (!l.reply) l.reply = { said, actions, plan, notes }
  }

  // Lines from before this turn (those already answered or left unanswered by a
  // cut-off turn); the lines this turn brings are its `just said` lines instead.
  render(now = Date.now(), before = now) {
    const shown = this.lines.filter(l => l.ts < before && now - l.ts <= KEEP_MS).slice(-MAX_LINES)
    if (!shown.length) return ''
    const line = (l) => {
      const parts = [`${ago(now - l.ts)} ago ${l.who}: "${clip(l.text.replace(/\s+/g, ' ').trim(), 160)}"`]
      const r = l.reply
      if (!r) return `${parts[0]} → (no answer yet)`
      parts.push(r.said ? `→ me: "${clip(r.said.replace(/\s+/g, ' ').trim(), 160)}"` : '→ me: (said nothing)')
      if (r.actions.length) parts.push(`did: ${r.actions.join(', ')}`)
      if (r.plan.length) parts.push(`plan: ${clip(r.plan.join('; '), 120)}`)
      if (r.notes.length) parts.push(`notes: ${r.notes.join('; ')}`)
      return parts.join(' ')
    }
    return `TALK=[${shown.map(line).join(' | ')}]`
  }
}

module.exports = { Talk, KEEP_MS }
