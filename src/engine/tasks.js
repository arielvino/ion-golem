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

const AGENDA_FILE = () => path.join(state.WORLD_DATA_DIR, 'agenda.json')

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

// The first goal on the focus's active path that can't be acted on yet (see
// GoalTree.planGap), with why: the bot must plan it before acting. Null when
// the path is planned, or the focus is an ongoing standing order (follow,
// guard), which has no route to plan.
function unplannedFocus() {
  const a = state.agenda
  const root = a?.focus()
  if (!root) return null
  if (!root.strategies.length && a.entries.find(e => e.id === root.id)?.ongoing) return null
  for (const n of a.tree.activePath(root.id)) {
    if (n.kind !== 'goal') continue
    const why = a.tree.planGap(n.id)
    if (why) return { goal: n, why }
  }
  return null
}

// Something changed that the routes in the tree were not written for.
function markRoutesStale(why) {
  if (!state.agenda) return
  state.agenda.tree.markStale(why)
  saveAgenda()
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
  markRoutesStale,
  loadAgenda, saveAgenda, syncStack, applyPlanTags, renderAgenda, agendaTitles,
  stackTitles, stackTop, stackTopTitle, unplannedFocus,
}
