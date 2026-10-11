// Turning archer — a test shooter, not a fighter: walks to ~7m, draws a full bow
// aimed away from its opponent, then turns onto it and looses 3 ticks later. A reflex that times the draw
// from when it was first aimed our way sees a fresh draw and waits.
const { goals, Movements } = require('mineflayer-pathfinder')
const { nearestOpponent, nextTick } = require('./common')

const kit = {
  hands: [['weapon.mainhand', 'bow']],
  bag: [['arrow', 64]]
}

async function run(bot, { opponents, signal }) {
  while (true) {
    const e = nearestOpponent(bot, opponents)
    if (!e) { await nextTick(bot, signal); continue }
    if (e.position.distanceTo(bot.entity.position) > 8) {
      const m = new Movements(bot)
      m.canDig = false
      bot.pathfinder.setMovements(m)
      await bot.pathfinder.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 7)).catch(() => {})
      if (signal.aborted) throw new Error('aborted')
    }
    const away = Math.atan2(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
    await bot.look(away, 0, true)   // mineflayer yaw faces -z at 0: this faces straight away
    bot.activateItem()
    for (let i = 0; i < 30; i++) await nextTick(bot, signal)
    // Straight at the chest, raised for the drop over the distance.
    const d = e.position.distanceTo(bot.entity.position)
    await bot.lookAt(e.position.offset(0, 1.2 + d * d * 0.003, 0), true)
    for (let i = 0; i < 3; i++) await nextTick(bot, signal)
    bot.deactivateItem()
    for (let i = 0; i < 20; i++) await nextTick(bot, signal)
  }
}

module.exports = { kit, run }
