// Defender v0 — the turtle: face the hunter behind a raised shield, back off when
// crowded, and drop the shield only for a fully charged counter-hit in reach.
const { opponentEntity, nextTick, hold } = require('./common')

const REACH = 3.0
const SWORD_COOLDOWN_MS = 625   // attack speed 1.6/s
const CROWDED = 2.5

async function run(bot, { opponent, signal }) {
  await hold(bot, 'iron_sword')
  await hold(bot, 'shield', 'off-hand')
  let lastSwing = 0
  let blocking = false
  while (true) {
    await nextTick(bot, signal)
    const e = opponentEntity(bot, opponent)
    if (!e) continue
    bot.lookAt(e.position.offset(0, e.height * 0.85, 0), true)
    const d = bot.entity.position.distanceTo(e.position)
    const now = Date.now()
    if (d < REACH && now - lastSwing >= SWORD_COOLDOWN_MS) {
      if (blocking) { bot.deactivateItem(); blocking = false }
      bot.attack(e)
      lastSwing = now
    } else if (!blocking) {
      bot.activateItem(true)
      blocking = true
    }
    bot.setControlState('back', d < CROWDED)
  }
}

module.exports = { run }
