// planSnapshot.js — what a pathfinder plan was given, saved when it timed out, so the
// same plan can be run again offline with a bigger budget (tools/plan-replay.js, #111).
// By the time anyone looks, the bot has usually changed the place (dug, bridged), so
// the world around the plan is saved with it.
//
// One gzipped JSON per timeout in <world dir>/plan-timeouts/. It holds the A*'s start
// node (position and scaffold count), the goal, the inventory and effects, the
// entities around, the terraform gate's facts, and the loaded chunk columns the search
// went through plus a ring around them and around the goal.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const state = require('../core/state')

// Chunks of margin around what the search visited, and around start and goal.
const RING = 2

// The node the search started from: the root of its best node's parent chain.
function startNode(result) {
  let node = result.context.bestNode
  while (node.parent) node = node.parent
  return node.data
}

function capture(bot, result, { goal, movements, planMs }) {
  if (!state.WORLD_DATA_DIR) return null
  const start = startNode(result)
  const chunks = new Set()
  const ring = (cx, cz) => { for (let dx = -RING; dx <= RING; dx++) for (let dz = -RING; dz <= RING; dz++) chunks.add(`${cx + dx},${cz + dz}`) }
  for (const k of result.context.visitedChunks) { const [cx, cz] = k.split(',').map(Number); ring(cx, cz) }
  ring(start.x >> 4, start.z >> 4)
  ring(goal.x >> 4, goal.z >> 4)
  const columns = []
  for (const k of chunks) {
    const [cx, cz] = k.split(',').map(Number)
    const col = bot.world.getColumn(cx, cz)
    if (col) columns.push({ cx, cz, json: col.toJson() })
  }
  // XRAY(planning): the search ran over the live world; so does its record. Read only
  // to replay the plan offline; nothing here reaches memory or the model.
  const loaded = bot.world.getColumns().map(c => [Number(c.chunkX), Number(c.chunkZ)])
  const { x: x1, z: z1 } = columns.reduce((a, c) => ({ x: Math.min(a.x, c.cx * 16), z: Math.min(a.z, c.cz * 16) }), { x: Infinity, z: Infinity })
  const { x: x2, z: z2 } = columns.reduce((a, c) => ({ x: Math.max(a.x, c.cx * 16 + 15), z: Math.max(a.z, c.cz * 16 + 15) }), { x: -Infinity, z: -Infinity })
  const inBox = (p) => p.x >= x1 && p.x <= x2 && p.z >= z1 && p.z <= z2
  // Blocks the gate never lets the walk dig (built ones, path blocks), inside the saved columns.
  const protectedCells = []
  try {
    const dim = require('../world/memory').currentDim()
    for (const t of ['placed_blocks WHERE structure_id IS NOT NULL AND', 'path_blocks WHERE']) {
      const rows = state.db.prepare(`SELECT x, y, z FROM ${t} dim=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?`).all(dim, x1, x2, z1, z2)
      for (const r of rows) protectedCells.push([r.x, r.y, r.z])
    }
  } catch (e) { console.log(`  plan snapshot: no protected blocks (${e.message})`) }
  const gate = require('./terraformGate')
  const snap = {
    at: new Date().toISOString(),
    version: bot.version,
    dimension: bot.game.dimension,
    minY: bot.game.minY,
    height: bot.game.height,
    position: bot.entity.position,
    onGround: bot.entity.onGround,
    goal,
    plan: { status: result.status, ms: planMs, visitedNodes: result.visitedNodes, steps: result.path.length },
    start: { x: start.x, y: start.y, z: start.z, remainingBlocks: start.remainingBlocks },
    movements: { thinkTimeout: bot.pathfinder.thinkTimeout, tickTimeout: bot.pathfinder.tickTimeout, scaffolding: movements.scafoldingBlocks.map(id => bot.registry.items[id]?.name) },
    items: bot.inventory.items().map(i => ({ name: i.name, count: i.count, nbt: i.nbt || null })),
    effects: bot.entity.effects,
    entities: Object.values(bot.entities).filter(e => e !== bot.entity && e.position && inBox(e.position))
      .map(e => ({ name: e.name, position: e.position, width: e.width, height: e.height })),
    gate: {
      bridgeOn: gate.isOn('bridge'),
      digOn: gate.isOn('dig'),
      permitted: require('../engine/breakPermission').permitted(),
      protected: protectedCells
    },
    loaded,
    columns
  }
  const dir = path.join(state.WORLD_DATA_DIR, 'plan-timeouts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${snap.at.replace(/[:.]/g, '-')}.json.gz`)
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(snap)))
  return file
}

function load(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
}

module.exports = { capture, load }
