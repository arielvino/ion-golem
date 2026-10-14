// Plan replay: run a pathfinder plan that timed out again, offline, with a bigger budget
// (#111). Reads the snapshots a walk saves on a plan timeout (src/navigation/planSnapshot.js)
// and plans from the same start, to the same goal, with the same rules, over the saved
// chunks, through mineflayer-pathfinder's own getPathFromTo. No server, no bot.
//
// The search runs unsliced until it ends or hits --cap, so its time is pure compute. Live
// planning gets at most 40 ms of every 50 ms tick and shares the event loop, so a 5 s cap
// buys less than 5 s of compute; compare node counts, which don't depend on the machine:
// live visited N nodes before its cap, the replay needs M to finish.
//
//   node tools/plan-replay.js <snapshot.json.gz | dir> [--cap 120]
//   (dir default: every plan-timeouts/ under ~/.local/share/iongolem/*/worlds/*)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { load } = require('../src/navigation/planSnapshot')

const argv = process.argv.slice(2)
const capArg = argv.indexOf('--cap')
const CAP_MS = (capArg >= 0 ? Number(argv.splice(capArg, 2)[1]) : 120) * 1000

function snapshotFiles(target) {
  if (target && fs.statSync(target).isFile()) return [target]
  const dirs = target ? [target] : globDirs()
  return dirs.flatMap(d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json.gz')).sort().map(f => path.join(d, f)) : [])
}

function globDirs() {
  const base = path.join(process.env.IONGOLEM_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'iongolem'))
  const out = []
  for (const bot of fs.readdirSync(base)) {
    const worlds = path.join(base, bot, 'worlds')
    if (!fs.existsSync(worlds)) continue
    for (const w of fs.readdirSync(worlds)) out.push(path.join(worlds, w, 'plan-timeouts'))
  }
  return out
}

// A bot with just what the planner reads: blocks, inventory, effects, entities, registry.
function fakeBot(snap) {
  const registry = require('prismarine-registry')(snap.version)
  const Chunk = require('prismarine-chunk')(registry)
  const World = require('prismarine-world')(registry)
  const world = new World(null).sync
  for (const c of snap.columns) world.setColumn(c.cx, c.cz, Chunk.fromJson(c.json))
  // Lookups that fall in a chunk the bot had loaded but the snapshot didn't save: the
  // search reached the snapshot's edge, where the live one would have found ground.
  const saved = new Set(snap.columns.map(c => `${c.cx},${c.cz}`))
  const loaded = new Set(snap.loaded.map(([x, z]) => `${x},${z}`))
  const edge = new Set()
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry,
    version: snap.version,
    game: { minY: snap.minY, height: snap.height, dimension: snap.dimension },
    entity: { position: new Vec3(snap.position.x, snap.position.y, snap.position.z), onGround: snap.onGround, effects: snap.effects || {}, height: 1.8, width: 0.6 },
    entities: {},
    controlState: {},
    world,
    blockAt (p) {
      const b = world.getBlock(p)
      if (!b) { const k = `${p.x >> 4},${p.z >> 4}`; if (!saved.has(k) && loaded.has(k)) edge.add(k) }
      return b
    },
    inventory: {
      items: () => snap.items.map(i => ({ ...i, type: registry.itemsByName[i.name]?.id }))
        .filter(i => i.type !== undefined)
    }
  })
  snap.entities.forEach((e, n) => { bot.entities[n] = { ...e, position: new Vec3(e.position.x, e.position.y, e.position.z) } })
  bot.entities.self = bot.entity
  require('mineflayer-pathfinder').pathfinder(bot)
  return { bot, edge }
}

function replay(file) {
  const snap = load(file)
  const { bot, edge } = fakeBot(snap)
  const { makeMovements } = require('../src/navigation/walkMovements')
  const { gateFor } = require('../src/navigation/terraformGate')
  const prot = new Set(snap.gate.protected.map(p => p.join(',')))
  const gate = gateFor({
    bridgeOn: () => snap.gate.bridgeOn,
    digOn: () => snap.gate.digOn,
    permitted: () => snap.gate.permitted,
    isProtected: (x, y, z) => prot.has(`${x},${y},${z}`),
    items: () => bot.inventory.items()
  })
  const movements = makeMovements(bot, true, gate)
  const Move = require('mineflayer-pathfinder/lib/move')
  const s = snap.start
  const startMove = new Move(s.x, s.y, s.z, s.remainingBlocks, 0)
  const { goals } = require('mineflayer-pathfinder')
  const goal = new goals.GoalNear(snap.goal.x, snap.goal.y, snap.goal.z, snap.goal.range)
  const gen = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { startMove, timeout: CAP_MS, tickTimeout: CAP_MS })
  const { value: { result: r } } = gen.next()
  return { snap, r, edge }
}

const files = snapshotFiles(argv[0])
if (!files.length) { console.log('no plan-timeout snapshots found'); process.exit(0) }
for (const f of files) {
  let out
  try { out = replay(f) } catch (e) { console.log(`${path.basename(f)}: replay failed: ${e.stack}`); continue }
  const { snap, r, edge } = out
  const s = snap.start, g = snap.goal
  const dist = Math.hypot(g.x - s.x, g.y - s.y, g.z - s.z).toFixed(0)
  const scaffold = snap.items.filter(i => snap.movements.scaffolding.includes(i.name)).reduce((a, i) => a + i.count, 0)
  console.log(`${path.basename(f)} ${snap.dimension}: ${s.x},${s.y},${s.z} → ${g.x},${g.y},${g.z} r=${g.range} (${dist} m), scaffold ${scaffold}` +
    `${snap.gate.bridgeOn ? '' : ' bridge=off'}${snap.gate.digOn ? '' : ' dig=off'}${snap.gate.permitted ? '' : ' no-break'}`)
  console.log(`  live:   ${snap.plan.status} after ${snap.plan.ms} ms, ${snap.plan.visitedNodes} nodes`)
  const factor = r.status === 'success' ? `, ${(r.visitedNodes / snap.plan.visitedNodes).toFixed(1)}× live's nodes` : ''
  console.log(`  replay: ${r.status} after ${Math.round(r.time)} ms, ${r.visitedNodes} nodes, ${r.path.length} steps, cost ${r.cost.toFixed(1)}${factor}` +
    `${edge.size ? ` — reached the snapshot's edge in ${edge.size} loaded chunk(s), so a noPath/route here may differ live` : ''}`)
}
