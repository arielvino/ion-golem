// Agenda — the ordered list of unrelated top-level goals.
//
// The old task stack conflated two relations: "do this next" (unrelated goals
// waiting their turn) and "needed for" (prerequisites). The agenda holds only
// the first; each entry is the root of a goal tree (goalTree.js), which holds
// the second. A prerequisite never goes on the agenda — it is a subgoal.
//
// Order is index 0 = top. push() puts an entry on top (an interruption: "survive
// the night" over "get an iron pickaxe"); queue() puts it at the bottom ("after
// that, build a house"); move() reorders. Focus is the first entry whose root
// still needs attention. Entries below the focus are suspended with their whole
// tree intact, so they resume exactly where they left off.
//
// Ownership: an entry is owned by the player who asked, or by 'self'. Only the
// owner can cancel it — the model cannot drop a player's goal on its own.
// `ongoing` marks goals with no natural end (guard, follow).
//
// Pure data + operations, like goalTree.js.

const { GoalTree, GoalTreeError } = require('./goalTree')

const LIVE = new Set(['open', 'verify'])
const CLOSED_KEPT = 300

class Agenda {
  constructor(tree) {
    this.tree = tree || new GoalTree()
    this.entries = [] // { id: rootGoalId, owner, ongoing }
    // Nodes of trees that have left the agenda: id → { root, status, at }. Notes
    // keep pointing at their goal after it is gone; this says how it ended.
    this.closed = {}
  }

  // ---- ordering ----

  push(text, meta) { return this._add(text, meta, 0) }
  queue(text, meta) { return this._add(text, meta, this.entries.length) }

  // Move an entry to a new position (0 = top).
  move(rootId, index) {
    const i = this._index(rootId)
    const [e] = this.entries.splice(i, 1)
    const at = Math.max(0, Math.min(index, this.entries.length))
    this.entries.splice(at, 0, e)
    return e
  }

  // Remove an entry and its tree. `by` is who is asking: 'self' or a player name.
  cancel(rootId, by) {
    const e = this.entries[this._index(rootId)]
    if (e.owner !== 'self' && by !== e.owner) {
      throw new GoalTreeError(`${rootId} belongs to ${e.owner}; only they can cancel it`)
    }
    this._drop(rootId, 'cancelled')
    return e
  }

  // Drop entries whose root the model has confirmed done. Returns them.
  prune() {
    const done = this.entries.filter(e => this.tree.nodes.get(e.id).status === 'done')
    for (const e of done) this._drop(e.id, 'done')
    return done
  }

  // ---- views ----

  focus() {
    const e = this.entries.find(e => LIVE.has(this.tree.nodes.get(e.id).status))
    return e ? this.tree.nodes.get(e.id) : null
  }

  // How a node stands, for a note that points at it: null while it is open (or
  // unknown), else { status, root, at } — at is when it closed, if it has left.
  nodeState(id) {
    const n = this.tree.nodes.get(id)
    if (n) return ['done', 'failed'].includes(n.status) ? { status: n.status, root: id } : null
    return this.closed[id] || null
  }

  // Legacy task-stack view: the active path through the focused tree.
  stackView() {
    const f = this.focus()
    return f ? this.tree.stackView(f.id) : []
  }

  // Text for the model: every entry as one line (suspended ones show where they
  // left off), then the focused tree at full resolution.
  render() {
    if (this.entries.length === 0) return ''
    const f = this.focus()
    const lines = ['AGENDA:']
    for (const e of this.entries) {
      const root = this.tree.nodes.get(e.id)
      const mark = f && root.id === f.id ? '▶' : ' '
      const tags = [e.owner, e.ongoing ? 'ongoing' : null].filter(Boolean).join(',')
      let tail = ''
      if (root.status === 'failed') {
        tail = e.owner === 'self' ? ' ← failed: new strategy or cancel' : ` ← failed: new strategy or ask ${e.owner}`
      } else if (root !== f && LIVE.has(root.status)) {
        const at = this.tree.activePath(root.id).at(-1)
        if (at && at !== root) tail = ` — suspended at ${at.id} ${at.text}`
      }
      lines.push(`${mark} ${root.id} ${root.text} [${root.status}] {${tags}}${tail}`)
    }
    if (f) lines.push('', this.tree.render(f.id))
    return lines.join('\n')
  }

  // ---- persistence ----

  toJSON() {
    return { tree: this.tree.toJSON(), entries: this.entries, closed: this.closed }
  }

  static fromJSON(data) {
    const a = new Agenda(GoalTree.fromJSON(data?.tree))
    a.entries = (data?.entries || []).filter(e => a.tree.nodes.has(e.id))
    a.closed = data?.closed || {}
    return a
  }

  // ---- internals ----

  _add(text, { owner, reason, ongoing } = {}, at) {
    if (!owner) throw new GoalTreeError("agenda entry needs an owner ('self' or a player name)")
    const root = this.tree.addGoal(null, { text, reason })
    this.entries.splice(at, 0, { id: root.id, owner, ongoing: !!ongoing })
    return root
  }

  _index(rootId) {
    const i = this.entries.findIndex(e => e.id === rootId)
    if (i < 0) throw new GoalTreeError(`${rootId} is not on the agenda`)
    return i
  }

  _drop(rootId, status) {
    this.entries.splice(this._index(rootId), 1)
    const at = Date.now()
    const mark = (id) => {
      const n = this.tree.nodes.get(id)
      this.closed[id] = { root: rootId, status, at }
      for (const c of n.kind === 'goal' ? n.strategies : n.goals) mark(c)
    }
    mark(rootId)
    const ids = Object.keys(this.closed)
    for (const id of ids.slice(0, Math.max(0, ids.length - CLOSED_KEPT))) delete this.closed[id]
    this.tree.removeRoot(rootId)
  }
}

module.exports = { Agenda }
