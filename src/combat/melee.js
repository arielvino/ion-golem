// melee.js — chase a target and swing at it until it dies or the fight is stopped.
//
// Ported from mineflayer-pvp (MIT, © 2020 TheDudeFromCI) as our fork pinned it: the
// stop names its target, the shield it raised comes down when the fight ends, the
// chase is re-aimed when it stalls out of reach, and swings are timed as crits.
// Unlike the plugin it never replaces the pathfinder's movements: the chase moves
// under the bot's own rules (no digging, no scaffolding), set in bot.js.
//
// One Melee per bot, as bot.melee. It emits on the bot:
//   startedAttacking, stoppedAttacking(target), attackedTarget.
const { goals } = require('mineflayer-pathfinder')
const ATTACK_SPEEDS = require('./attackSpeeds.json')

// Critical hits: jump this many ticks before a swing is due, and wait at most this
// many ticks past it for the fall.
const CRIT_JUMP_LEAD = 6
const CRIT_MAX_HOLD = 8

/** Ticks between full-damage swings with this weapon (attack speed per second → ticks). */
function cooldownTicks(weaponName) {
  const speed = ATTACK_SPEEDS[weaponName] || ATTACK_SPEEDS.other
  return Math.floor(1 / speed * 20)
}

/** The weapon's cooldown give or take up to 2 ticks, at least 1. */
function swingTicks(bot) {
  const held = bot.inventory.slots[bot.getEquipmentDestSlot('hand')]
  return Math.max(1, Math.floor(Math.random() * 4 - 2) + cooldownTicks(held?.name ?? ''))
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

class Melee {
  constructor(bot) {
    this.bot = bot
    this.target = undefined
    this.timeToNextAttack = 0
    this.wasInRange = false
    this.refollowTicks = 0
    // Set by creeperDefense while it blocks or evades a fuse: no swings meanwhile.
    this.blockingExplosion = false
    this.critJumpTicks = -1
    this.critHoldTicks = 0
    this.followRange = 2       // how close the chase gets
    this.viewDistance = 128    // a target farther than this is given up
    this.attackRange = 3.0     // how close the target must be to swing
    this.criticalHits = true   // time swings as crits (x1.5 damage)
    this.raisedShield = false  // the shield is up because we raised it
    bot.on('physicsTick', () => this.update())
    bot.on('entityGone', e => { if (e === this.target) this.stop() })
  }

  /** Start attacking an entity until it is killed or the fight is stopped. */
  async attack(target) {
    if (target === this.target) return
    await this.stop()
    this.target = target
    this.timeToNextAttack = 0
    if (!this.target) return
    this.bot.pathfinder.setGoal(new goals.GoalFollow(this.target, this.followRange), true)
    this.bot.emit('startedAttacking')
  }

  /** Stop attacking, and wait (at most 5 s) for the pathfinder to come to a stop. */
  async stop() {
    if (this.target == null) return
    // A new attack may start before path_stop arrives, so name the target that stopped.
    const target = this.target
    this.target = undefined
    this.lowerShield()
    this.bot.pathfinder.stop()
    if (!await this.once('path_stop', 5000)) this.bot.pathfinder.setGoal(null)
    this.bot.emit('stoppedAttacking', target)
  }

  /** Stop attacking at once; the pathfinder drops its goal mid-move. */
  forceStop() {
    if (this.target == null) return
    const target = this.target
    this.target = undefined
    this.lowerShield()
    this.bot.pathfinder.setGoal(null)
    this.bot.emit('stoppedAttacking', target)
  }

  /** Whether the bot emits `event` within `ms`; removes only its own listener. */
  once(event, ms) {
    return new Promise(resolve => {
      const done = (fired) => { clearTimeout(timer); this.bot.removeListener(event, onEvent); resolve(fired) }
      const onEvent = () => done(true)
      const timer = setTimeout(() => done(false), ms)
      this.bot.once(event, onEvent)
    })
  }

  update() {
    this.checkExplosion()
    this.checkRange()
    // Stopped mid crit jump: don't leave the jump key down.
    if (!this.target && this.critJumpTicks >= 0) {
      this.bot.setControlState('jump', false)
      this.critJumpTicks = -1
    }
    if (!this.target || this.blockingExplosion) return
    this.critTick()
    this.timeToNextAttack--
    if (this.timeToNextAttack === -1) this.attemptAttack()
  }

  checkRange() {
    if (!this.target || this.timeToNextAttack < 0) return
    const dist = this.target.position.distanceTo(this.bot.entity.position)
    if (dist > this.viewDistance) { this.stop(); return }
    const inRange = dist <= this.attackRange
    // Coming into reach: swing now, or jump now and swing on the way down.
    if (!this.wasInRange && inRange) {
      this.timeToNextAttack = 0
      if (this.canCritJump()) {
        this.startCritJump()
        this.timeToNextAttack = CRIT_JUMP_LEAD
      }
    }
    this.wasInRange = inRange
    // GoalFollow keeps the target's block until the target moves more than followRange
    // from it, and counts as reached within followRange of that block: together that
    // can stop the bot ~4 blocks away, past attackRange. Out of reach with the
    // pathfinder idle, aim the goal at where the target is now (at most every 10 ticks).
    if (!inRange && !this.bot.pathfinder.isMoving() && --this.refollowTicks <= 0) {
      this.refollowTicks = 10
      this.bot.pathfinder.setGoal(new goals.GoalFollow(this.target, this.followRange), true)
    }
  }

  canCritJump() {
    const e = this.bot.entity
    return this.criticalHits && this.critJumpTicks < 0 && e.onGround && !e.isInWater && !e.isInLava
  }

  startCritJump() {
    this.bot.setControlState('jump', true)
    this.critJumpTicks = 0
  }

  // Critical hits: a swing lands as a crit while falling, not on the ground and not
  // sprinting. Jump CRIT_JUMP_LEAD ticks before the swing is due (a jump's apex is ~6
  // ticks up), stop sprinting once airborne, and hold a swing that's due while not
  // yet falling for a tick: on the first falling tick the server hasn't counted any
  // fall yet, and the hit lands plain.
  critTick() {
    const e = this.bot.entity
    if (this.critJumpTicks >= 0) {
      this.critJumpTicks++
      if (this.critJumpTicks > 1) {
        this.bot.setControlState('jump', false)
        this.bot.setControlState('sprint', false)
        if (e.onGround) this.critJumpTicks = -1
      }
    } else if (this.wasInRange && this.timeToNextAttack === CRIT_JUMP_LEAD && this.canCritJump()) {
      this.startCritJump()
    }
    if (this.timeToNextAttack !== 0) return
    if (this.criticalHits && !e.onGround && e.velocity.y > -0.1 && this.critHoldTicks < CRIT_MAX_HOLD) {
      this.timeToNextAttack = 1
      this.critHoldTicks++
    } else {
      this.critHoldTicks = 0
    }
  }

  // A creeper target lighting its fuse: stop, face it and block for 2 s.
  checkExplosion() {
    const t = this.target
    if (!t || !this.hasShield()) return
    if (t.name === 'creeper' && t.metadata[16] === 1) {
      this.blockingExplosion = true
      this.bot.pathfinder.stop()
      this.bot.lookAt(t.position.offset(0, 1, 0), true)
      this.bot.activateItem(true)
      this.raisedShield = true
      setTimeout(() => { this.blockingExplosion = false }, 2000)
    }
  }

  // Swing at the target: lower the shield, look, hit, raise it again. A swing that
  // finds the target changed is dropped; the new attack has its own timer.
  async attemptAttack() {
    if (!this.target) return
    if (!this.wasInRange) { this.timeToNextAttack = swingTicks(this.bot); return }
    const target = this.target
    const shield = this.hasShield()
    try {
      if (shield) {
        this.bot.deactivateItem()
        this.raisedShield = false
        await sleep(100)
      }
      if (target !== this.target) return
      await this.bot.lookAt(target.position.offset(0, target.height, 0), true)
      if (target !== this.target) return
      this.bot.attack(target)
      this.bot.emit('attackedTarget')
      if (shield) {
        await sleep(150)
        if (target !== this.target) return
        if (this.hasShield()) {
          this.bot.activateItem(true)
          this.raisedShield = true
        }
      }
    } catch (e) {
      return
    }
    this.timeToNextAttack = swingTicks(this.bot)
  }

  /** Lower the shield if we raised it, so the bot doesn't walk on blocking after a fight. */
  lowerShield() {
    if (!this.raisedShield) return
    this.raisedShield = false
    if (this.hasShield()) this.bot.deactivateItem()
  }

  hasShield() {
    if (this.bot.supportFeature('doesntHaveOffHandSlot')) return false
    const slot = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')]
    return !!slot && slot.name.includes('shield')
  }
}

module.exports = { Melee, cooldownTicks }
