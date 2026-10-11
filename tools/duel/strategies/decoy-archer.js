// Decoy archer — a test shooter, not a fighter: draws its bow fully and looses
// into the sky, over and over. A reflex that answers it is answering a draw that
// was never aimed at anyone.
const { nextTick } = require('./common')

const kit = {
  hands: [['weapon.mainhand', 'bow']],
  bag: [['arrow', 64]]
}

async function run(bot, { signal }) {
  while (true) {
    await bot.look(0, Math.PI / 3, true)   // well up, facing south
    bot.activateItem()
    for (let i = 0; i < 22; i++) await nextTick(bot, signal)
    bot.deactivateItem()
    for (let i = 0; i < 20; i++) await nextTick(bot, signal)
  }
}

module.exports = { kit, run }
