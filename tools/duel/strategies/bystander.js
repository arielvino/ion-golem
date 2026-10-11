// Bystander — a test target: holds a sword, stands still, and does nothing but
// run the bot's reflexes.
const { nextTick } = require('./common')

const kit = {
  hands: [['weapon.mainhand', 'iron_sword']],
  bag: []
}

async function run(bot, { signal }) {
  while (true) await nextTick(bot, signal)
}

module.exports = { kit, run }
