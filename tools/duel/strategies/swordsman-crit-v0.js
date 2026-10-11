// Swordsman crit v0 — swordsman-noshield-v0's `attack` loop, with critical hits:
// pvp's swing is timed to land while falling from a jump (×1.5 damage). Jump
// JUMP_LEAD ticks before the swing is due, stop sprinting (a sprinting hit can't
// crit), and hold the swing until clearly falling: on the first falling
// tick the server hasn't counted any fall yet, and the hit lands plain.
const { run: attackLoop } = require('./swordsman-v0')

const kit = {
  hands: [['weapon.mainhand', 'iron_sword']],
  bag: [['cooked_beef', 8]]
}

const JUMP_LEAD = 6     // a jump's apex is ~6 ticks up
const MAX_HOLD = 8      // ticks to wait for the fall before swinging anyway

function critTiming(bot) {
  const pvp = bot.pvp
  if (pvp._crit) return
  pvp._crit = true
  const update = pvp.update.bind(pvp)
  let held = 0, airborne = false
  pvp.update = function () {
    const e = bot.entity
    if (this.target && this.wasInRange && this.timeToNextAttack === JUMP_LEAD && e.onGround) {
      bot.setControlState('jump', true)
      airborne = true
    } else if (airborne) {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
      if (e.onGround && this.timeToNextAttack < JUMP_LEAD - 1) airborne = false
    }
    // Swing due next tick but not yet falling for a tick: wait.
    if (this.timeToNextAttack === 0 && !e.onGround && e.velocity.y > -0.1 && held < MAX_HOLD) {
      this.timeToNextAttack = 1
      held++
    } else if (this.timeToNextAttack === 0) held = 0
    update()
  }
}

async function run(bot, ctx) {
  critTiming(bot)
  return attackLoop(bot, ctx)
}

module.exports = { kit, run }
