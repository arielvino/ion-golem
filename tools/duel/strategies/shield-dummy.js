// Shield dummy — a test target, not a fighter: stands still facing the opponent
// with the shield raised, and never attacks.
const { nearestOpponent, nextTick, hold } = require('./common')

const kit = {
  hands: [['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']],
  bag: []
}

async function run(bot, { opponents, signal }) {
  await hold(bot, 'shield', 'off-hand')
  bot.activateItem(true)
  while (true) {
    await nextTick(bot, signal)
    const e = nearestOpponent(bot, opponents)
    if (e) bot.lookAt(e.position.offset(0, e.height * 0.85, 0), true)
  }
}

module.exports = { kit, run }
