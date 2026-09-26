// Goal tree — a composite AND-OR tree of goals and strategies.
//
// A GOAL is an outcome; it is achieved by any ONE of its strategies (OR).
// A STRATEGY is a route; it needs ALL of its subgoals (AND). A strategy with no
// subgoals is a leaf, carried out directly by actions.
//
// Only one strategy per goal is ACTIVE; the others stay DORMANT, not discarded,
// so a better route can be reopened later. The "active path" (root → active
// strategy → next actionable subgoal → …) is what the bot is working on, and is
// what the legacy flat task stack becomes a view of.
//
// Completion checks: a goal is judged either by the model (`check: 'model'`) or
// by code (`check: 'have:<item>:<n>'`). Root goals are always model-judged —
// only the model knows whether "give Sargon an iron pickaxe" is really done.
// Code checks latch: once satisfied, a goal stays done even if the items are
// later consumed by the parent's own crafting.
//
// Pure data + operations; no bot or fs access. The caller supplies a `world`
// ({ count(itemName) }) to refresh() and handles persistence via toJSON/fromJSON.

const GOAL_STATUS = ['open', 'verify', 'done', 'failed']
const STRAT_STATUS = ['dormant', 'active', 'done', 'failed']

class GoalTreeError extends Error {}

function parseCheck(check) {
  if (check == null || check === 'model') return { by: 'model' }
  const m = /^have:([a-z0-9_]+):(\d+)$/.exec(String(check).trim())
  if (!m) throw new GoalTreeError(`bad check "${check}" — use "model" or "have:<item>:<n>"`)
  return { by: 'code', item: m[1], n: Number(m[2]) }
}

function checkKey(check) {
  return check.by === 'code' ? `have:${check.item}:${check.n}` : null
}

function evalCheck(check, world) {
  if (check.by !== 'code') return false
  return world.count(check.item) >= check.n
}

class GoalTree {
  constructor() {
    this.nodes = new Map() // id → node
    this.roots = []        // goal ids, oldest first; focus = newest open root
    this.seq = 0
  }

  // ---- construction ----

  addGoal(parentStrategyId, { text, check, reason, after } = {}) {
    if (!text) throw new GoalTreeError('goal needs text')
    const parent = parentStrategyId ? this._get(parentStrategyId, 'strategy') : null
    const chk = parseCheck(check)
    if (!parent && chk.by !== 'model') throw new GoalTreeError('root goals are model-judged; omit check')
    if (parent) this._assertNoCycle(parent, chk)
    const goal = {
      id: `g${++this.seq}`, kind: 'goal', text, check: chk, reason: reason || '',
      status: 'open', parent: parent ? parent.id : null,
      strategies: [], active: null, after: after || [],
    }
    if (parent) {
      for (const a of goal.after) {
        if (!parent.goals.includes(a)) throw new GoalTreeError(`after: ${a} is not a sibling subgoal of ${parent.id}`)
      }
      parent.goals.push(goal.id)
    } else {
      this.roots.push(goal.id)
    }
    this.nodes.set(goal.id, goal)
    return goal
  }

  addStrategy(goalId, { text, est } = {}) {
    if (!text) throw new GoalTreeError('strategy needs text')
    const goal = this._get(goalId, 'goal')
    const strat = {
      id: `s${++this.seq}`, kind: 'strategy', text, parent: goal.id,
      status: 'dormant', goals: [], est: est || null,
    }
    this.nodes.set(strat.id, strat)
    goal.strategies.push(strat.id)
    if (!goal.active && goal.status === 'open') this.activate(strat.id)
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
    if (goal.active && goal.active !== strat.id) this.nodes.get(goal.active).status = 'dormant'
    goal.active = strat.id
    strat.status = 'active'
    return strat
  }

  // Model verdict on a goal. 'done' may be given from open or verify.
  // 'open' reopens a done/verify goal (e.g. the model saw it was premature).
  markGoal(goalId, status) {
    const goal = this._get(goalId, 'goal')
    if (!GOAL_STATUS.includes(status)) throw new GoalTreeError(`bad goal status "${status}"`)
    if (status === 'failed') return this._failGoal(goal)
    goal.status = status
    if (status === 'done') this._subgoalDone(goal)
    return goal
  }

  // Mark a leaf strategy finished. For a non-leaf this happens automatically
  // when all its subgoals are done.
  completeStrategy(strategyId) {
    const strat = this._get(strategyId, 'strategy')
    strat.status = 'done'
    const goal = this.nodes.get(strat.parent)
    if (goal.status !== 'open') return strat
    // Code-checked goals decide for themselves on the next refresh(); a
    // model-checked goal asks the model to confirm.
    if (goal.check.by === 'model') goal.status = 'verify'
    return strat
  }

  // A strategy is dead. Its goal loses its active route; if no viable strategy
  // remains the goal fails, which fails the parent strategy, and so on up.
  // Choosing among the surviving dormant strategies is left to the model.
  failStrategy(strategyId) {
    const strat = this._get(strategyId, 'strategy')
    strat.status = 'failed'
    const goal = this.nodes.get(strat.parent)
    if (goal.active === strat.id) goal.active = null
    const viable = goal.strategies.some(id => this.nodes.get(id).status === 'dormant')
    if (!viable) this._failGoal(goal)
    return strat
  }

  // ---- world ----

  // Evaluate code checks on open goals; returns the ids that became done.
  refresh(world) {
    const changed = []
    for (const node of this.nodes.values()) {
      if (node.kind !== 'goal' || node.status !== 'open' || node.check.by !== 'code') continue
      if (evalCheck(node.check, world)) {
        node.status = 'done'
        changed.push(node.id)
      }
    }
    for (const id of changed) this._subgoalDone(this.nodes.get(id))
    return changed
  }

  // ---- views ----

  focus() {
    for (let i = this.roots.length - 1; i >= 0; i--) {
      const g = this.nodes.get(this.roots[i])
      if (g.status === 'open' || g.status === 'verify') return g
    }
    return null
  }

  // Subgoals of a strategy that can be worked on now: open, and every `after`
  // sibling done.
  actionable(strategyId) {
    const strat = this._get(strategyId, 'strategy')
    return strat.goals.map(id => this.nodes.get(id)).filter(g =>
      g.status === 'open' && g.after.every(a => this.nodes.get(a).status === 'done'))
  }

  // [goal, strategy, goal, strategy, …] from the focus root down to the first
  // node that needs work. Ends at a goal with no active strategy (needs a
  // decision), a goal awaiting verification, or a leaf strategy (needs actions).
  activePath() {
    const path = []
    let goal = this.focus()
    while (goal) {
      path.push(goal)
      if (goal.status === 'verify' || !goal.active) break
      const strat = this.nodes.get(goal.active)
      path.push(strat)
      goal = this.actionable(strat.id)[0] || null
    }
    return path
  }

  // Legacy task-stack view: one {t,d,r} entry per goal on the active path,
  // bottom = root. Keeps existing engine code working on top of the tree.
  stackView() {
    const path = this.activePath()
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
  render() {
    const lines = []
    const path = this.activePath()
    const onPath = new Set(path.map(n => n.id))
    for (const n of path) {
      const depth = this._depth(n)
      const pad = '  '.repeat(depth)
      if (n.kind === 'goal') {
        const chk = n.check.by === 'code' ? ` check=${checkKey(n.check)}` : ''
        const why = n.reason ? ` {${n.reason}}` : ''
        const need = n.status === 'verify' ? ' ← confirm done?'
          : !n.active ? ' ← choose strategy' : ''
        lines.push(`${pad}${n.id} GOAL ${n.text} [${n.status}]${chk}${why}${need}`)
        for (const sid of n.strategies) {
          if (onPath.has(sid)) continue
          const s = this.nodes.get(sid)
          lines.push(`${pad}  ${s.id} ${s.status} ${s.text}${fmtEst(s.est)}`)
        }
      } else {
        const leaf = n.goals.length === 0 ? ' ← act' : ''
        lines.push(`${pad}${n.id} STRAT ${n.text} [${n.status}]${fmtEst(n.est)}${leaf}`)
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
    return { seq: this.seq, roots: this.roots, nodes: [...this.nodes.values()] }
  }

  static fromJSON(data) {
    const t = new GoalTree()
    if (!data) return t
    t.seq = data.seq || 0
    t.roots = data.roots || []
    for (const n of data.nodes || []) t.nodes.set(n.id, n)
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

  // Reject a subgoal whose code check repeats an ancestor's — needing the
  // pickaxe to get the iron to make the pickaxe.
  _assertNoCycle(parentStrategy, chk) {
    const key = checkKey(chk)
    if (!key) return
    for (let id = parentStrategy.parent; id; id = this.nodes.get(id).parent) {
      const n = this.nodes.get(id)
      if (n.kind === 'goal' && checkKey(n.check) === key) {
        throw new GoalTreeError(`cycle: ${key} is already required by ancestor ${n.id}`)
      }
    }
  }

  // A subgoal finished: if it was the last one, its strategy is done.
  _subgoalDone(goal) {
    if (!goal.parent) return
    const strat = this.nodes.get(goal.parent)
    if (strat.status !== 'active') return
    if (strat.goals.every(id => this.nodes.get(id).status === 'done')) this.completeStrategy(strat.id)
  }

  _failGoal(goal) {
    goal.status = 'failed'
    goal.active = null
    if (goal.parent) {
      const strat = this.nodes.get(goal.parent)
      if (strat.status === 'active' || strat.status === 'dormant') this.failStrategy(strat.id)
    }
    return goal
  }
}

function fmtEst(est) {
  if (!est) return ''
  const parts = []
  if (est.min != null) parts.push(`≈${est.min}min`)
  if (est.conf != null) parts.push(`conf ${est.conf}`)
  return parts.length ? ` (${parts.join(' ')})` : ''
}

module.exports = { GoalTree, GoalTreeError, parseCheck, GOAL_STATUS, STRAT_STATUS }
