// Journal (journal.js) bound to bot state and disk.
//
// Records come in through logEvent/recordFailure (core/utils.js). The context
// shows unseen records as NEW= and the notes as a NOTES block; once the model has
// replied, the shown records are marked seen. [NOTE:...] tags from the reply are
// applied here; failures come back next turn as NOTE_ERR, like PLAN_ERR.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')
const { Journal } = require('./journal')

const JOURNAL_FILE = () => path.join(state.BOT_DATA_DIR, 'journal.json')

function loadJournal() {
  state.journal = new Journal()
  try {
    const f = JOURNAL_FILE()
    if (fs.existsSync(f)) state.journal = Journal.fromJSON(JSON.parse(fs.readFileSync(f, 'utf-8')))
  } catch (e) { console.warn('  [JOURNAL] load err:', e.message) }
  if (state.journal.notes.length) console.log(`  [JOURNAL] restored ${state.journal.notes.length} notes, ${state.journal.records.length} records`)
}

function saveJournal() {
  if (!state.journal) return
  try { fs.writeFileSync(JOURNAL_FILE(), JSON.stringify(state.journal)) } catch (e) { console.warn('  [JOURNAL] save err:', e.message) }
}

// The node the bot is working on now — where a new note belongs.
function currentNode() {
  const f = state.agenda?.focus()
  return f ? state.agenda.tree.activePath(f.id).at(-1).id : null
}

// NEW= for the context blob. Remembers how far it showed, for markShown().
function renderNew() {
  if (!state.journal) return ''
  state.journalShownUpTo = state.journal.rseq
  return state.journal.renderNew()
}

// Multi-line block (NOTES + NOTE_ERR) that hangs outside the blob.
function renderNotesBlock() {
  if (!state.journal) return ''
  const out = []
  const notes = state.journal.renderNotes()
  if (notes) out.push(notes)
  if (state.noteErrors.length) {
    out.push(`NOTE_ERR=[${state.noteErrors.join(' | ')}]`)
    state.noteErrors = []
  }
  return out.join('\n')
}

// `[NOTE:text [r1,r2]]` and `[NOTE:compact:n3-n9:text [r4]]`. The body may itself
// contain one level of [...] (the citations), so a plain [^\]]+ would cut it short.
const NOTE_TAG = /\[NOTE:((?:[^[\]]|\[[^[\]]*\])*)\]/g

// Apply every [NOTE:...] in a reply. Monitor turns (the cheap model) may add
// notes but not compact — compaction rewrites history, which is where drift gets in.
function applyNoteTags(rawReply, { allowCompact }) {
  if (!state.journal) return []
  const applied = []
  for (const m of rawReply.matchAll(NOTE_TAG)) {
    const body = m[1].trim()
    try {
      const cm = /^compact:([^:]+):([\s\S]*)$/.exec(body)
      if (cm) {
        if (!allowCompact) throw new Error('compact is not available on monitor turns')
        const { note, replaced } = state.journal.compact(cm[1], cm[2], currentNode())
        applied.push(`${note.id} ← ${replaced.join(',')}`)
      } else {
        applied.push(state.journal.note(body, currentNode()).id)
      }
    } catch (e) {
      state.noteErrors.push(`${body.slice(0, 60)} → ${e.message}`)
    }
  }
  if (applied.length) saveJournal()
  return applied
}

// After a reply: the NEW= records it was shown are now seen.
function markShown() {
  if (!state.journal || !state.journalShownUpTo) return
  state.journal.markShown(state.journalShownUpTo)
  saveJournal()
}

module.exports = { loadJournal, saveJournal, renderNew, renderNotesBlock, applyNoteTags, markShown, NOTE_TAG }
