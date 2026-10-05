// [PLAN:op:...] — the model's commands for editing the agenda and goal trees.
//
//   push:<text>           new agenda goal on top (interrupts)       → g#
//   queue:<text>          new agenda goal at the bottom (later)     → g#
//   move:<g#>:<index>     reorder an agenda goal (0 = top)
//   cancel:<g#>           remove an agenda goal (owner only)
//   strat:<g#>:<text>     add a strategy to a goal (first = active) → s#
//   sub:<s#>:<text>       add a subgoal to a strategy               → g#
//                         optional trailing " after=g4,g5" for order
//   use:<s#>              switch the goal to this strategy
//   done:<g#|s#>          goal achieved / leaf strategy finished
//   fail:<g#|s#>          goal or strategy is dead
//   reopen:<g#>           goal was not really done
//
// In place of an id, `new` names a node this same reply created, whose id the
// model can't know yet: the last goal for ops that take a goal, the last
// strategy for sub/use, and the last node of either kind for done/fail.
// So [PLAN:push:X][PLAN:strat:new:Y] builds a goal and its route in one turn.
//
// Free text is always the last field, so it may contain ':'. A {reason} at the
// end of a push/queue text overrides the default reason.
//
// Pure: parse() turns tag contents into an op, apply() runs it on an Agenda.
// Both throw GoalTreeError with a message meant to be shown back to the model.

const { GoalTreeError } = require('./goalTree')

const OPS = {
  push: ['text'], queue: ['text'],
  move: ['id', 'index'], cancel: ['id'],
  strat: ['id', 'text'], sub: ['id', 'text'],
  use: ['id'], done: ['id'], fail: ['id'], reopen: ['id'],
}

function parse(body) {
  const parts = body.split(':')
  const op = parts[0].trim().toLowerCase()
  const fields = OPS[op]
  if (!fields) throw new GoalTreeError(`unknown op "${op}" — have: ${Object.keys(OPS).join(', ')}`)
  const out = { op }
  let i = 1
  for (const f of fields) {
    const v = f === 'text' ? parts.slice(i).join(':').trim() : (parts[i] || '').trim()
    if (!v) throw new GoalTreeError(`${op} needs ${fields.map(x => `<${x}>`).join(':')}`)
    out[f] = v
    i++
  }
  if (op === 'move') {
    out.index = Number(out.index)
    if (!Number.isInteger(out.index)) throw new GoalTreeError(`move index must be a number`)
  }
  if (out.text && (op === 'push' || op === 'queue')) {
    const m = /^(.*?)\s*\{([^}]*)\}\s*$/.exec(out.text)
    if (m) { out.text = m[1]; out.reason = m[2].trim() }
  }
  if (out.text && op === 'sub') {
    const m = /^(.*?)\s+after=([gs0-9,\s]+)$/.exec(out.text)
    if (m) { out.text = m[1]; out.after = m[2].split(',').map(s => s.trim()).filter(Boolean) }
  }
  if (fields.includes('text') && !out.text) throw new GoalTreeError(`${op} needs text`)
  return out
}

const NEW_KIND = { strat: 'goal', move: 'goal', cancel: 'goal', reopen: 'goal', sub: 'strat', use: 'strat', done: 'last', fail: 'last' }

// Run an op. `by` is who is speaking this turn: a player name, or 'self'.
// `made` is shared across one reply's ops: what they created, for `new`.
// Returns a short description for logging.
function apply(agenda, op, by, made = {}) {
  const t = agenda.tree
  const node = (id) => {
    const n = t.nodes.get(id)
    if (!n) throw new GoalTreeError(`no node ${id}`)
    return n
  }
  if (op.id === 'new') {
    const kind = NEW_KIND[op.op]
    if (!made[kind]) throw new GoalTreeError(`"new" means a ${kind === 'strat' ? 'strategy' : kind === 'goal' ? 'goal' : 'node'} created earlier in this same reply — there is none`)
    op = { ...op, id: made[kind] }
  }
  const made1 = (n, kind) => { made[kind] = n.id; made.last = n.id; return n }
  switch (op.op) {
    case 'push':
    case 'queue': {
      const reason = op.reason || (by === 'self' ? '' : `${by} asked`)
      const g = made1(agenda[op.op](op.text, { owner: by, reason }), 'goal')
      return `${op.op} ${g.id} "${g.text}"`
    }
    case 'move': agenda.move(op.id, op.index); return `move ${op.id} → ${op.index}`
    case 'cancel': agenda.cancel(op.id, by); return `cancel ${op.id}`
    case 'strat': {
      const s = made1(t.addStrategy(op.id, { text: op.text }), 'strat')
      return `strat ${s.id} "${s.text}" for ${op.id}${s.status === 'active' ? ' (active)' : ''}`
    }
    case 'sub': {
      const g = made1(t.addGoal(op.id, { text: op.text, after: op.after }), 'goal')
      return `sub ${g.id} "${g.text}" under ${op.id}`
    }
    case 'use': t.activate(op.id); return `use ${op.id}`
    case 'done': {
      const n = node(op.id)
      if (n.kind === 'goal') t.markGoal(n.id, 'done')
      else if (n.goals.length > 0) throw new GoalTreeError(`${n.id} has subgoals — it finishes when they are done`)
      else t.completeStrategy(n.id)
      agenda.prune()
      return `done ${op.id}`
    }
    case 'fail': {
      const n = node(op.id)
      if (n.kind === 'goal') t.markGoal(n.id, 'failed')
      else t.failStrategy(n.id)
      return `fail ${op.id}`
    }
    case 'reopen': {
      const n = node(op.id)
      if (n.kind !== 'goal') throw new GoalTreeError(`reopen takes a goal (g#), got ${op.id}`)
      t.markGoal(n.id, 'open')
      return `reopen ${op.id}`
    }
  }
}

module.exports = { parse, apply, OPS }
