// Archer v0 — the bot's own `shoot` action with a bow, over and over: solved arc,
// led target, up to 10 arrows per call. No sword, no shield, no footwork.
const { sleep } = require('./common')
const { doShoot } = require('../../../src/actions/ranged')

const kit = {
  hands: [['weapon.mainhand', 'bow']],
  bag: [['arrow', 64], ['cooked_beef', 8]]
}

async function run(bot, { opponent, signal }) {
  while (!signal.aborted) {
    await doShoot(`${opponent}:bow`)
    await sleep(250)   // no shot (out of sight, behind cover): look again shortly
  }
}

module.exports = { kit, run }
