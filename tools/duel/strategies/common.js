// Helpers shared by duel strategies.
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// The opponent's entity, once it's loaded.
function opponentEntity(bot, name) {
  return bot.players[name]?.entity || null
}

// The nearest opponent still in the fight (alive and on the arena floor, not
// benched on the roof), or null.
function nearestOpponent(bot, names) {
  let best = null
  for (const n of names) {
    const e = opponentEntity(bot, n)
    if (!e || e.position.y > bot.entity.position.y + 6) continue
    if (!best || e.position.distanceTo(bot.entity.position) < best.position.distanceTo(bot.entity.position)) best = e
  }
  return best
}

// Resolves on the next physics tick, or rejects once the round is over.
function nextTick(bot, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    bot.once('physicsTick', resolve)
  })
}

async function hold(bot, itemName, hand = 'hand') {
  const slot = hand === 'off-hand' ? bot.inventory.slots[45] : bot.heldItem
  if (slot?.name === itemName) return
  const item = bot.inventory.items().find(i => i.name === itemName)
  if (item) await bot.equip(item, hand)
}

module.exports = { sleep, opponentEntity, nearestOpponent, nextTick, hold }
