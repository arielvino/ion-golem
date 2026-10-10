// Turtle v0 — face the opponent behind a raised shield, back off when
// crowded, and drop the shield only for a fully charged counter-hit in reach.
const { nearestOpponent, nextTick, hold } = require('./common')

const kit = {
  hands: [['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']],
  bag: [['cooked_beef', 8]]
}

const REACH = 3.0
const SWORD_COOLDOWN_MS = 625   // attack speed 1.6/s
const CROWDED = 2.5

async function run(bot, { opponents, signal }) {
  await hold(bot, 'iron_sword')
  await hold(bot, 'shield', 'off-hand')
  let lastSwing = 0
  let blocking = false
  while (true) {
    await nextTick(bot, signal)
    const e = nearestOpponent(bot, opponents)
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

module.exports = { kit, run }
