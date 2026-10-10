// Hunter v0 — the bot's own melee today (src/actions/combat.js doAttack): best
// sword in hand, shield in the off-hand, and mineflayer-pvp chases and swings.
const { sleep, opponentEntity, hold } = require('./common')

async function run(bot, { opponent, signal }) {
  await hold(bot, 'iron_sword')
  await hold(bot, 'shield', 'off-hand')
  while (!signal.aborted) {
    const e = opponentEntity(bot, opponent)
    if (e && bot.pvp.target !== e) bot.pvp.attack(e)
    await sleep(250)
  }
}

module.exports = { run }
