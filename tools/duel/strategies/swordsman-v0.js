// Swordsman v0 — the bot's own `attack` action: best weapon in hand, shield in the
// off-hand, mineflayer-pvp chases and swings until the target dies or 30s pass.
const { sleep } = require('./common')
const { doAttack } = require('../../../src/actions/combat')

const kit = {
  hands: [['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']],
  bag: [['cooked_beef', 8]]
}

async function run(bot, { opponent, signal }) {
  while (!signal.aborted) {
    await doAttack(opponent)
    await sleep(250)
  }
}

module.exports = { kit, run }
