// blockActivity.js — someone else working on blocks in sight, as journal records.
//
// The server shows every player the crack animation of a block being mined and the
// lid of a chest being opened. A player digging next to the bot, or going through a
// chest, is something it sees; vision only catches the result, later, as a changed
// block. Only blocks in line of sight count.
const { Vec3 } = require('vec3')
const { logEvent } = require('../core/utils')
const { blockVisible } = require('./visibility')
const ranges = require('../config/ranges')

const BREAK_GATHER_MS = 5000   // one breaker's blocks within this become one record
const SETTLE_MS = 300          // after the crack ends, the block update has arrived
const OWN_CONTAINER_BLOCKS = 6 // a lid this close while the bot has a window open is its own

let bound = null

function record(text) {
  console.log(`  [EVT] ${text}`)
  logEvent(text)
}

const at = (p) => `${p.x},${p.y},${p.z}`

function seenBlock(bot, pos) {
  if (!bot.entity || !pos) return false
  const eye = bot.entity.position.offset(0, 1.62, 0)
  if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) > ranges.sight.viewBlocks) return false
  return blockVisible(eye, pos.x, pos.y, pos.z)
}

const who = (e) => e?.username || (e?.name ? `a ${e.name}` : 'someone')

// "stone ×2, dirt"
function tally(names) {
  const n = new Map()
  for (const x of names) n.set(x, (n.get(x) || 0) + 1)
  return [...n].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)).join(', ')
}

function bind(bot) {
  if (bound === bot) return
  bound = bot

  const cracking = new Map()   // "x,y,z" → { name, by } for visible blocks being mined
  const broken = new Map()     // breaker → { names: [], last: Vec3, timer }

  bot.on('blockBreakProgressObserved', (block, stage, entity) => {
    if (!block || entity === bot.entity) return
    const key = at(block.position)
    if (cracking.has(key) || !seenBlock(bot, block.position)) return
    cracking.set(key, { name: block.name, by: who(entity) })
  })

  bot.on('blockBreakProgressEnd', (block) => {
    if (!block) return
    const pos = block.position.clone()
    const c = cracking.get(at(pos))
    if (!c) return
    cracking.delete(at(pos))
    setTimeout(() => {
      if (bot.blockAt(pos)?.name === c.name) return   // stopped mining, the block stands
      const b = broken.get(c.by) || { names: [], last: null, timer: null }
      b.names.push(c.name)
      b.last = pos
      if (b.timer) clearTimeout(b.timer)
      b.timer = setTimeout(() => {
        broken.delete(c.by)
        const n = b.names.length
        record(`block: ${c.by} broke ${n > 1 ? `${n} blocks (${tally(b.names)})` : b.names[0]} ${n > 1 ? 'around' : 'at'} ${at(b.last)}`)
      }, BREAK_GATHER_MS)
      broken.set(c.by, b)
    }, SETTLE_MS)
  })

  const own = new Set()    // chests the bot opened itself; their close is its own too
  bot.on('chestLidMove', (block, viewers) => {
    if (!block) return
    const pos = block.position
    const key = at(pos)
    if (viewers === 0 && own.delete(key)) return
    if (bot.currentWindow && bot.entity && bot.entity.position.distanceTo(pos) <= OWN_CONTAINER_BLOCKS) { own.add(key); return }
    if (!seenBlock(bot, pos)) return
    record(viewers > 0
      ? `container: ${block.name} at ${at(pos)} opened${viewers > 1 ? ` (${viewers} looking in)` : ''}`
      : `container: ${block.name} at ${at(pos)} closed`)
  })
}

module.exports = { bind, tally }
