// Trident man v0 — the bot's own `shoot` action with a Loyalty trident, over and
// over: wind up, solved arc, led target, wait for it to fly back. No melee, no
// shield, no footwork.
const { sleep, nearestOpponent } = require('./common')
const { doShoot } = require('../../../src/actions/ranged')

const kit = {
  hands: [['weapon.mainhand', 'trident[enchantments={loyalty:3}]']],
  bag: [['cooked_beef', 8]]
}

async function run(bot, { opponents, signal }) {
  while (!signal.aborted) {
    const e = nearestOpponent(bot, opponents)
    if (e) await doShoot(`${e.username}:trident`)
    await sleep(250)   // no throw (out of sight, behind cover): look again shortly
  }
}

module.exports = { kit, run }
