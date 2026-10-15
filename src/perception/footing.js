// footing.js — what the bot knows by its own body, not by sight: the cells its body fills and
// the block holding it up. Vision often can't see these: the bot's own column hides
// them (the pillar it is building, the floor of a hole), yet standing on a block
// proves it is there. Recorded the moment the bot's block position or footing
// changes, so memory never lags behind where the bot actually is.
const { Vec3 } = require('vec3')
const state = require('../core/state')

const BODY_HEIGHT = 1.8

// [x, y, z] cells touched at `pos`: every cell the body spans, plus, when on the
// ground, the block holding it up (on a slab that is the body's own lowest cell).
function touchedCells(pos, onGround) {
  const x = Math.floor(pos.x), z = Math.floor(pos.z)
  const cells = []
  for (let y = Math.floor(pos.y); y <= Math.floor(pos.y + BODY_HEIGHT - 0.001); y++) cells.push([x, y, z])
  if (onGround) {
    const support = Math.floor(pos.y - 0.001)
    if (support < Math.floor(pos.y)) cells.unshift([x, support, z])
  }
  return cells
}

function bind(bot) {
  let last = ''
  bot.on('physicsTick', () => {
    const e = bot.entity
    if (!e || !state.stmts?.upsertBlock) return
    const cells = touchedCells(e.position, e.onGround)
    const key = cells.map(c => c.join(',')).join(';')
    if (key === last) return
    last = key
    const tick = bot.time?.age || 0
    for (const [x, y, z] of cells) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) continue
      try { state.stmts.upsertBlock.run(x, y, z, b.name, tick, b.stateId) } catch (err) {}
    }
  })
}

module.exports = { bind, touchedCells }
