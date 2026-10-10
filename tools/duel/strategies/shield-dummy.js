// Shield dummy — a test target, not a fighter: stands still facing the opponent
// with the shield raised, and never attacks.
const { opponentEntity, nextTick, hold } = require('./common')

const kit = {
  hands: [['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']],
  bag: []
}

async function run(bot, { opponent, signal }) {
  await hold(bot, 'shield', 'off-hand')
  bot.activateItem(true)
  while (true) {
    await nextTick(bot, signal)
    const e = opponentEntity(bot, opponent)
    if (e) bot.lookAt(e.position.offset(0, e.height * 0.85, 0), true)
  }
}

module.exports = { kit, run }
