// Agenda + goal trees, bound to bot state and disk.
//
// state.agenda is the source of truth (see agenda.js, goalTree.js). The model
// edits it with [PLAN:op:...] tags (planOps.js). state.taskStack is a DERIVED
// view — the active path through the focused goal, {t,d,r} bottom-first — kept
// for engine code that only needs "what am I working on". Never mutate it;
// change the agenda and call syncStack().
const fs = require('fs')
const path = require('path')
const state = require('../core/state')
const { logTaskAction } = require('../world/memory')
const { Agenda } = require('./agenda')
const planOps = require('./planOps')

const AGENDA_FILE = () => path.join(state.BOT_DATA_DIR, 'agenda.json')

function syncStack() { state.taskStack = state.agenda.stackView() }

function saveAgenda() {
  syncStack()
  try { fs.writeFileSync(AGENDA_FILE(), JSON.stringify(state.agenda)) } catch (e) { console.warn('  [TASKS] agenda save err:', e.message) }
}

function loadAgenda() {
  state.agenda = new Agenda()
  try {
    const f = AGENDA_FILE()
    if (fs.existsSync(f)) state.agenda = Agenda.fromJSON(JSON.parse(fs.readFileSync(f, 'utf-8')))
  } catch (e) { console.warn('  [TASKS] agenda load err:', e.message) }
  syncStack()
  if (state.agenda.entries.length > 0) console.log(`  [AGENDA] restored: ${agendaTitles()}`)
}

function agendaTitles() {
  return state.agenda.entries.map(e => state.agenda.tree.nodes.get(e.id).text).join(' | ')
}

function stackTitles() { return state.taskStack.map(e => e.t).join(' > ') }
function stackTop() { return state.taskStack.length > 0 ? state.taskStack[state.taskStack.length - 1] : null }
function stackTopTitle() { const top = stackTop(); return top ? top.t : null }

// Apply every [PLAN:...] tag in a model reply, in order. `by` is who spoke this
// turn (a player name, or 'self') and decides ownership and cancel rights.
// Failures are kept in state.planErrors and shown to the model next turn.
function applyPlanTags(rawReply, by) {
  const applied = []
  const made = {}
  for (const m of rawReply.matchAll(/\[PLAN:([^\]]+)\]/g)) {
    try {
      const desc = planOps.apply(state.agenda, planOps.parse(m[1]), by, made)
      applied.push(desc)
      state.planOpCount++
      logTaskAction('plan', desc, by, agendaTitles() || '(empty)')
    } catch (e) {
      state.planErrors.push(`${m[1]} → ${e.message}`)
    }
  }
  if (applied.length) saveAgenda()
  return applied
}

// Context block for the model; empty when there is nothing to show.
function renderAgenda() {
  const out = []
  const view = state.agenda.render()
  if (view) out.push(view)
  if (state.planErrors.length) {
    out.push(`PLAN_ERR=[${state.planErrors.join(' | ')}]`)
    state.planErrors = []
  }
  return out.join('\n')
}

module.exports = {
  loadAgenda, saveAgenda, syncStack, applyPlanTags, renderAgenda, agendaTitles,
  stackTitles, stackTop, stackTopTitle,
}
