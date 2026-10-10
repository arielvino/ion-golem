// Swordsman v0 without a shield: the same `attack` loop, so arrows are answered by
// the reflexes' sidestep only.
const { run } = require('./swordsman-v0')

const kit = {
  hands: [['weapon.mainhand', 'iron_sword']],
  bag: [['cooked_beef', 8]]
}

module.exports = { kit, run }
