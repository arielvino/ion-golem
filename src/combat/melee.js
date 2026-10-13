// melee.js — chase a target and swing at it until it dies or the fight is stopped.
//
// Ported from mineflayer-pvp (MIT, © 2020 TheDudeFromCI), with our fork's changes:
// swings timed as crits, keepDistance spacing and knockback hits, and the fixes
// below. Unlike the plugin it never replaces the pathfinder's movements: the chase
// moves under the bot's own rules (no digging, no scaffolding), set in bot.js.
//
// Bugs in upstream mineflayer-pvp that we fixed here (and in our fork, PR numbers on
// arielvino/mineflayer-pvp), to contribute to PrismarineJS/mineflayer-pvp:
//   1. attack() installs pvp's own default Movements on the shared pathfinder, and
//      they stay after the fight: the chase, and every move after it, may dig through
//      walls, tower and scaffold with the bot's blocks. Fix: leave the bot's
//      movements alone (#8, closed unmerged).
//   2. stop() with no path_stop within 5 s calls removeAllListeners('path_stop'),
//      dropping other plugins' listeners too; fix: remove only its own (#1).
//   3. stoppedAttacking names no target, so a caller can't tell a stale stop of the
//      previous attack from the end of its own; fix: emit it with the target (#1).
//   4. The shield pvp raises around swings stays up after the fight ends, and the bot
//      walks on blocking (slowed); fix: lower it on stop (#2).
//   5. GoalFollow keeps the target's block until the target moves more than
//      followRange from it and counts as reached within followRange of that block:
//      the chase can stop ~4 blocks away, past attackRange, and never swing; fix:
//      re-aim the goal while out of reach with the pathfinder idle (#3).
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
    // Spacing for melee: keep the target between near and far blocks away (centre to
    // centre). Closer than near while the next swing isn't ready, back off; the chase
    // closes in no nearer than the band's middle. A player reaches ~3 blocks, a
    // zombie-like mob only ~1.4, so a band like [2.2, 2.9] hits without being hit.
    // Undefined: off.
    this.keepDistance = undefined
    // Sprint-hit every swing for the extra knockback: a fresh start-sprint just before
    // it. A melee mob knocked 2-3 blocks back has to walk in again and meets the next
    // swing at the edge of our reach, before it's close enough to hit. A sprinting hit
    // can't crit, so this turns criticalHits off.
    this.knockbackHits = false
    this.spacing = false       // backing off inside keepDistance's near edge
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
    this.bot.pathfinder.setGoal(this.followGoal(this.target), true)
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
    // Stopped while backing off: don't leave the back key down.
    if (!this.target && this.spacing) this.endSpacing()
    if (!this.target || this.blockingExplosion) return
    this.critTick()
    this.spacingTick()
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
      this.bot.pathfinder.setGoal(this.followGoal(this.target), true)
    }
  }

  canCritJump() {
    const e = this.bot.entity
    return this.criticalHits && !this.knockbackHits && this.critJumpTicks < 0 && e.onGround && !e.isInWater && !e.isInLava
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
    if (this.criticalHits && !this.knockbackHits && !e.onGround && e.velocity.y > -0.1 && this.critHoldTicks < CRIT_MAX_HOLD) {
      this.timeToNextAttack = 1
      this.critHoldTicks++
    } else {
      this.critHoldTicks = 0
    }
  }

  /** How close the chase brings the bot: the middle of keepDistance when set. */
  followGoal(target) {
    const range = this.keepDistance ? (this.keepDistance[0] + this.keepDistance[1]) / 2 : this.followRange
    return new goals.GoalFollow(target, range)
  }

  // Back off while the target is inside keepDistance's near edge and the next swing
  // isn't due, with the pathfinder's goal paused so it doesn't walk us back in.
  spacingTick() {
    const target = this.target
    if (!this.keepDistance || !target) {
      if (this.spacing) this.endSpacing()
      return
    }
    const d = target.position.distanceTo(this.bot.entity.position)
    if (d < this.keepDistance[0] && this.timeToNextAttack > 1) {
      if (!this.spacing) {
        this.spacing = true
        this.bot.pathfinder.setGoal(null)
      }
      this.bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true)
      this.bot.setControlState('forward', false)
      this.bot.setControlState('sprint', false)
      this.bot.setControlState('back', true)
    } else if (this.spacing) {
      this.endSpacing()
    }
  }

  endSpacing() {
    this.spacing = false
    this.bot.setControlState('back', false)
    if (this.target) this.bot.pathfinder.setGoal(this.followGoal(this.target), true)
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
      if (this.knockbackHits) {
        // Off and on again: a control already on sends no new start-sprint.
        this.bot.setControlState('sprint', false)
        this.bot.setControlState('sprint', true)
      }
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
