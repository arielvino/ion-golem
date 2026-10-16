// Goal tree — a composite AND-OR tree of goals and strategies.
//
// A GOAL is an outcome; it is achieved by any ONE of its strategies (OR).
// A STRATEGY is a route; it needs ALL of its subgoals (AND). A strategy with no
// subgoals is a leaf, carried out directly by actions.
//
// Only one strategy per goal is ACTIVE; the others stay DORMANT, not discarded,
// so a better route can be reopened later. The "active path" (root → active
// strategy → next actionable subgoal → …) is what the bot is working on.
//
// This is decomposition only. The tree holds any number of roots, unordered;
// which root is worked on, and in what order, is the Agenda's job (agenda.js).
//
// Every verdict is the model's, at every level: a node is done or failed only
// when the model says so, and nothing rolls up or down by itself. A strategy
// isn't finished because its subgoals are done (routes are decomposed one level
// at a time, so they may be just the first steps); a goal isn't achieved
// because its route finished, nor failed because its routes did; a strategy
// isn't dead because one of its subgoals failed (the model may replace that
// step). Where the tree needs a verdict, render() puts a marker on the node.
// Handing specific checks over to code is a later step.
//
// Pure data + operations; no bot or fs access. The caller handles persistence
// via toJSON/fromJSON.

const GOAL_STATUS = ['open', 'done', 'failed']
const STRAT_STATUS = ['dormant', 'active', 'done', 'failed']

class GoalTreeError extends Error {}

class GoalTree {
  constructor() {
    this.nodes = new Map() // id → node
    this.seq = 0
  }

  // ---- construction ----

  addGoal(parentStrategyId, { text, reason, after, first } = {}) {
    if (!text) throw new GoalTreeError('goal needs text')
    const parent = parentStrategyId ? this._get(parentStrategyId, 'strategy') : null
    const goal = {
      id: `g${++this.seq}`, kind: 'goal', text, reason: reason || '',
      status: 'open', parent: parent ? parent.id : null,
      strategies: [], active: null, after: after || [],
    }
    if (parent) {
      for (const a of goal.after) {
        if (!parent.goals.includes(a)) throw new GoalTreeError(`after: ${a} is not a sibling subgoal of ${parent.id}`)
      }
      // `first`: a step that has to come before the open ones, e.g. a
      // prerequisite found missing halfway: it takes the focus from them.
      if (first) parent.goals.unshift(goal.id)
      else parent.goals.push(goal.id)
    }
    this.nodes.set(goal.id, goal)
    return goal
  }

  addStrategy(goalId, { text, est, needs, pack, lack } = {}) {
    if (!text) throw new GoalTreeError('strategy needs text')
    const goal = this._get(goalId, 'goal')
    const strat = {
      id: `s${++this.seq}`, kind: 'strategy', text, parent: goal.id,
      status: 'dormant', goals: [], est: est || null,
      needs: needs || null, pack: pack || null, lack: lack || null, stale: null,
    }
    // A new route for a failed goal is the model saying it has another way to try.
    if (goal.status === 'failed') goal.status = 'open'
    this.nodes.set(strat.id, strat)
    goal.strategies.push(strat.id)
    if (!this._route(goal) && goal.status === 'open') this.activate(strat.id)
    return strat
  }

  // ---- decisions ----

  // Switch a goal to this strategy. The previous active one goes dormant, not away.
  activate(strategyId) {
    const strat = this._get(strategyId, 'strategy')
    if (strat.status === 'failed' || strat.status === 'done') {
      throw new GoalTreeError(`${strat.id} is ${strat.status}; cannot activate`)
    }
    const goal = this.nodes.get(strat.parent)
    const prev = this._route(goal)
    if (prev && prev !== strat) prev.status = 'dormant'
    goal.active = strat.id
    strat.status = 'active'
    strat.stale = null
    return strat
  }

  // Something happened that the active routes were not written for (e.g. death
  // emptied the inventory): each one says so until the model keeps it
  // ([PLAN:use:] on it) or replaces it.
  markStale(why) {
    for (const n of this.nodes.values()) {
      if (n.kind === 'strategy' && n.status === 'active') n.stale = why
    }
  }

  // Why this goal can't be acted on yet, or null. Its route has to be walked
  // through first: no route at all, a route whose lack= has no subgoal to get
  // it, or a route written before something changed it.
  planGap(goalId) {
    const goal = this._get(goalId, 'goal')
    if (goal.status !== 'open') return null
    if (!goal.strategies.length) return 'no route'
    const strat = goal.active && this.nodes.get(goal.active)
    if (!strat || strat.status !== 'active') return null
    if (strat.stale) return `route ${strat.id} was written before ${strat.stale}`
    if (lacks(strat) && !strat.goals.length) return `route ${strat.id} lacks ${strat.lack} and has no subgoal to get it`
    return null
  }

  // Model verdict on a goal. 'open' reopens a done or failed goal (e.g. the
  // model saw it was premature).
  markGoal(goalId, status) {
    const goal = this._get(goalId, 'goal')
    if (!GOAL_STATUS.includes(status)) throw new GoalTreeError(`bad goal status "${status}"`)
    goal.status = status
    // Reopened after its route finished: that route is spent, so the goal has
    // none until the model adds or picks one (a new strategy then activates).
    if (status === 'open' && goal.active && this.nodes.get(goal.active).status === 'done') goal.active = null
    return goal
  }

  // Mark a strategy finished: a leaf, or one with no open subgoal left (a
  // failed one counts as settled: the model has replaced or dropped that step).
  // Its goal stays open until the model judges it.
  completeStrategy(strategyId) {
    const strat = this._get(strategyId, 'strategy')
    const left = strat.goals.filter(id => this.nodes.get(id).status === 'open')
    if (left.length) throw new GoalTreeError(`${strat.id} still has subgoals to finish: ${left.join(', ')}`)
    strat.status = 'done'
    return strat
  }

  // A strategy is dead. Its goal loses its active route, and stays open: picking
  // another route, or failing the goal, is the model's call.
  failStrategy(strategyId) {
    const strat = this._get(strategyId, 'strategy')
    strat.status = 'failed'
    const goal = this.nodes.get(strat.parent)
    if (goal.active === strat.id) goal.active = null
    return strat
  }

  // Delete a root and its whole subtree.
  removeRoot(rootId) {
    const root = this._get(rootId, 'goal')
    if (root.parent) throw new GoalTreeError(`${rootId} is not a root`)
    const drop = (id) => {
      const n = this.nodes.get(id)
      for (const c of n.kind === 'goal' ? n.strategies : n.goals) drop(c)
      this.nodes.delete(id)
    }
    drop(rootId)
  }

  // ---- views ----

  roots() {
    return [...this.nodes.values()].filter(n => n.kind === 'goal' && !n.parent)
  }

  // Subgoals of a strategy that need attention now: open, with every `after`
  // sibling done.
  actionable(strategyId) {
    const strat = this._get(strategyId, 'strategy')
    return strat.goals.map(id => this.nodes.get(id)).filter(g =>
      g.status === 'open' && g.after.every(a => this.nodes.get(a).status === 'done'))
  }

  // [goal, strategy, goal, strategy, …] from a root down to the first node that
  // needs work. Ends at a goal that needs a verdict or a route (none active, or
  // its route finished), or at a strategy (a leaf needs actions; otherwise it has
  // no actionable subgoal and needs the next step or a verdict).
  activePath(rootId) {
    const path = []
    let goal = this._get(rootId, 'goal')
    while (goal) {
      path.push(goal)
      if (goal.status !== 'open' || !goal.active || this.nodes.get(goal.active).status === 'done') break
      const strat = this.nodes.get(goal.active)
      path.push(strat)
      goal = this.actionable(strat.id)[0] || null
    }
    return path
  }

  // Legacy task-stack view: one {t,d,r} entry per goal on the active path,
  // bottom = root. Keeps existing engine code working on top of the tree.
  stackView(rootId) {
    const path = this.activePath(rootId)
    const out = []
    for (let i = 0; i < path.length; i++) {
      const n = path[i]
      if (n.kind !== 'goal') continue
      const strat = path[i + 1]
      out.push({ t: n.text, d: strat ? `via ${strat.text}` : '', r: n.reason })
    }
    return out
  }

  // Compact text for the model: the active path at full resolution, dormant and
  // finished siblings along it as one-liners, everything else suppressed.
  render(rootId) {
    const lines = []
    const path = this.activePath(rootId)
    const onPath = new Set(path.map(n => n.id))
    for (const n of path) {
      const depth = this._depth(n)
      const pad = '  '.repeat(depth)
      if (n.kind === 'goal') {
        const why = n.reason ? ` {${n.reason}}` : ''
        const strats = n.strategies.map(id => this.nodes.get(id))
        const need = n.status !== 'open' ? ''
          : n.strategies.length === 0 ? ' ← plan a route'
          : n.active && this.nodes.get(n.active).status === 'done' ? ` ← route done: done:${n.id} if achieved, else another route`
          : !n.active && strats.every(s => s.status === 'failed') ? ` ← every route failed: add another, or fail:${n.id}`
          : !n.active ? ' ← choose strategy' : ''
        lines.push(`${pad}${n.id} GOAL ${n.text} [${n.status}]${why}${need}`)
        for (const sid of n.strategies) {
          if (onPath.has(sid)) continue
          const s = this.nodes.get(sid)
          lines.push(`${pad}  ${s.id} ${s.status} ${s.text}${fmtEst(s.est)}`)
        }
      } else {
        const subs = n.goals.map(id => this.nodes.get(id))
        const failed = subs.filter(g => g.status === 'failed').map(g => g.id).join(',')
        const leaf = n.stale ? ` ← written before ${n.stale}: keep it ([PLAN:use:${n.id}]) or replace it ([PLAN:strat:${n.parent}:…] then [PLAN:use:new])`
          : lacks(n) && n.goals.length === 0 ? ` ← lack= has no subgoal: [PLAN:sub:${n.id}:…] for what you lack`
          : n.goals.length === 0 ? ' ← act'
          : this.actionable(n.id).length > 0 ? ''
          : subs.some(g => g.status === 'open') ? ` ← steps wait on failed ${failed}: add a replacement, or fail:${n.id}`
          : failed ? ` ← steps done, ${failed} failed: add the next or a replacement, or done:${n.id} / fail:${n.id}`
          : ` ← steps done: add the next, or done:${n.id}`
        lines.push(`${pad}${n.id} STRAT ${n.text} [${n.status}]${fmtEst(n.est)}${leaf}`)
        if (n.needs || n.pack) lines.push(`${pad}  needs: ${n.needs || '?'} | pack: ${n.pack || '?'} | lack: ${n.lack || '?'}`)
        for (const gid of n.goals) {
          if (onPath.has(gid)) continue
          const g = this.nodes.get(gid)
          const wait = g.status === 'open' && g.after.length ? ` after ${g.after.join(',')}` : ''
          lines.push(`${pad}  ${g.id} ${g.status} ${g.text}${wait}`)
        }
      }
    }
    return lines.join('\n')
  }

  // ---- persistence ----

  toJSON() {
    return { seq: this.seq, nodes: [...this.nodes.values()] }
  }

  static fromJSON(data) {
    const t = new GoalTree()
    if (!data) return t
    t.seq = data.seq || 0
    for (const n of data.nodes || []) {
      if (n.kind === 'goal' && n.status === 'verify') n.status = 'open'   // retired status: now a marker
      t.nodes.set(n.id, n)
    }
    return t
  }

  // ---- internals ----

  _get(id, kind) {
    const n = this.nodes.get(id)
    if (!n) throw new GoalTreeError(`no node ${id}`)
    if (kind && n.kind !== kind) throw new GoalTreeError(`${id} is a ${n.kind}, not a ${kind}`)
    return n
  }

  _depth(node) {
    let d = 0
    for (let p = node.parent; p; p = this.nodes.get(p).parent) d++
    return d
  }

  // The goal's strategy in progress: the active one, unless it has finished.
  _route(goal) {
    const s = goal.active && this.nodes.get(goal.active)
    return s && s.status === 'active' ? s : null
  }
}

// lack= names what the route takes and doesn't get in its own steps; "none"
// (or nothing written, from before lack= existed) means it has all of it.
function lacks(strat) {
  return !!strat.lack && !/^none\b/i.test(strat.lack.trim())
}

function fmtEst(est) {
  if (!est) return ''
  const parts = []
  if (est.min != null) parts.push(`≈${est.min}min`)
  if (est.conf != null) parts.push(`conf ${est.conf}`)
  return parts.length ? ` (${parts.join(' ')})` : ''
}

module.exports = { GoalTree, GoalTreeError, GOAL_STATUS, STRAT_STATUS }
