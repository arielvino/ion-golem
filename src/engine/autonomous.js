// Autonomous behaviors — health, drowning, damage, idle pickup
const state = require('../core/state')
const { sleep } = require('../core/tick')
const { sendChat } = require('../core/utils')
const { HEALTH_AUTOEAT, FOOD_FULL, OXYGEN_DROWNING, OXYGEN_FALL_SAFE } = require('../config/safety')
const { WATER_BLOCKS, FIRE_BLOCKS } = require('../config/blocks')
const T = require('../config/timings')
const { entityTag } = require('../perception/entityTag')
const { damageCause, hasAttacker } = require('../perception/damageCause')

function setupAutonomous(interruptFn) {
  const bot = state.bot
  const ranged = require('./rangedDefense')
  ranged.setupRangedDefense()
  require('./retreat').setupRetreat(interruptFn)
  require('./creeperDefense').setupCreeperDefense()
  require('./projectileGuard').setupProjectileGuard()
  require('./gazeGuard').setupGazeGuard()
  require('./dragonBreathGuard').setupDragonBreathGuard()

  // --- AUTO-EAT on low health ---
  bot.on('health', () => {
    if (bot.health <= HEALTH_AUTOEAT && bot.food < FOOD_FULL && !state.retreating) {
      const { edibleFoods } = require('../actions/vitals')
      // One eat at a time: 'health' fires on every HP/food change.
      const eating = state.backgroundTask?.action === 'eat' || state.actionQueue.some(a => a.actionStr === 'eat')
      if (edibleFoods(bot).length > 0 && !eating) {
        console.log(`  [AUTO] HP=${Math.round(bot.health)}, eating`)
        interruptFn({ keepResponse: true, keepFlee: true })
        // Prepend eat to front of queue instead of replacing
        setTimeout(() => {
          state.actionQueue.unshift({ actionStr: 'eat', username: 'auto' })
        }, T.QUEUE_PREPEND_DELAY)
      }
    }
  })

  // --- FLOAT: never sink ---
  // Hold jump while the eyes are under water, so the bot rises and bobs at the surface
  // instead of sinking whenever nothing steers it (idle, after a stop, a dig, a swimup).
  // The pathfinder steers its own swimming, so the reflex stands down while it has a path, and
  // for a grace second after: with a goal it is pathless for a few ticks on every replan and
  // stuck reset, and a jump held then fights its steering. A goal it sits in without a path
  // for longer (a melee follow in range, no path found) steers nothing, so the reflex returns.
  // A player can switch it off (`!float off`, floatMode.js).
  const float = require('./floatMode')
  const PATHLESS_GRACE_TICKS = 20
  let floating = false, pathless = 0
  const release = () => { if (floating) { bot.setControlState('jump', false); floating = false } }
  bot.on('physicsTick', () => {
    const e = bot.entity
    if (!float.isOn()) return release()
    const pf = bot.pathfinder
    pathless = pf?.isMoving() || !pf?.goal ? 0 : pathless + 1
    const steered = pf?.isMoving() || (pf?.goal && pathless <= PATHLESS_GRACE_TICKS)
    if (!e || bot.health <= 0) return release()
    // Steered: the pathfinder owns the controls, and may already have set jump this tick
    // (to hold its depth while it digs in water), so stand down without touching them.
    if (steered) { floating = false; return }
    const eye = bot.blockAt(e.position.offset(0, 1.62, 0))
    if (e.isInWater && eye && (WATER_BLOCKS.has(eye.name) || eye.name === 'bubble_column')) {
      if (!bot.controlState.jump) bot.setControlState('jump', true)
      floating = true
    } else if (floating) {
      bot.setControlState('jump', false)
      floating = false
    }
  })

  // --- DROWNING PROTECTION ---
  // Out of air despite the float: something overhead holds the bot under. Preempt
  // whatever runs and launch swimup now (it digs through) — queued behind a task or
  // the engine tick it came too late, and the next AI reply wiped it.
  let lastDrowningDispatch = 0
  bot.on('breath', () => {
    if (bot.oxygenLevel <= OXYGEN_DROWNING && Date.now() - lastDrowningDispatch > T.DROWNING_DEBOUNCE) {
      // Verify head is actually in water — oxygenLevel can be stale/bogus
      try {
        const headBlock = bot.blockAt(bot.entity.position.offset(0, 1.62, 0))
        if (!headBlock || (!WATER_BLOCKS.has(headBlock.name) && headBlock.name !== 'bubble_column')) return
      } catch (e) { return }
      lastDrowningDispatch = Date.now()
      console.log(`  [AUTO] DROWNING! oxygen=${bot.oxygenLevel}, dispatching swimup`)
      // keepResponse: an AI turn in flight finishes; only the running task dies.
      interruptFn({ keepResponse: true, keepFlee: true })
      setTimeout(() => {
        state.actionQueue.unshift({ actionStr: 'swimup', username: 'auto' })
        require('./engine').processActionQueue()
      }, T.QUEUE_PREPEND_DELAY)
    }
  })

  // --- AUTO-FIGHT: interrupt whatever runs and put an attack at the front ---
  // No cooldown between fights: the next hostile is engaged as soon as melee drops the
  // last one. Only an attack still launching (target alive) holds off a second one.
  // Melee if the bot can get within reach on foot, else a ranged weapon, else nothing
  // (combat/engage.js); a mob it can't answer is not re-planned for DECLINE_MS.
  let pending = null, pendingAt = 0
  const declined = new Map()   // entity id → time it was declined
  const DECLINE_MS = 3000
  // True when it answered the mob: launched an attack, or logged why not.
  function autoFight(attacker, logLine, chatLine) {
    // Running from a swarm (the reflex or a flee action) beats turning to fight.
    if (bot.melee.target || state.retreating || state.currentTask === 'fleeing') return false
    // So does a flee the model asked for that is still waiting to launch: the attack's
    // interrupt would clear it from the queue (#82).
    if (state.actionQueue.some(a => a.actionStr.split(':')[0] === 'flee')) return false
    if (state.creeperReflex) return false   // a creeper is fusing: block or run first, fight after
    if (state.dragonBreathReflex) return false    // in dragon's breath: get out first
    if (pending?.isValid && Date.now() - pendingAt < T.AUTOFIGHT_LAUNCH_GRACE) return false
    const tag = entityTag(attacker)
    if (state.shooting && state.currentTask === `shooting ${tag}`) return false   // already on it
    if (Date.now() - (declined.get(attacker.id) || 0) < DECLINE_MS) return false
    const { action, why } = require('../combat/engage').chooseEngagement(bot, attacker)
    if (!action) {
      // Said once per mob (defend mode asks again every few ticks); after that the
      // caller logs a hit as a plain hit.
      const first = !declined.has(attacker.id)
      if (declined.size > 200) declined.clear()
      declined.set(attacker.id, Date.now())
      if (!first) return false
      console.log(`  [AUTO] ${logLine}; not fighting back: ${why}`)
      require('../core/utils').logEvent(`reflex: ${logLine} → not fighting back: ${tag} is ${why}`)
      return true
    }
    pending = attacker; pendingAt = Date.now()
    console.log(`  [AUTO] ${logLine} → ${action} (${why})`)
    require('../core/utils').logEvent(`reflex: ${logLine} → ${action}`)
    sendChat(chatLine)
    // keepResponse: a reflex kills the running task, never the model's turn. A stream of
    // mobs (a spawner) used to abort every turn, so the model never got to answer it.
    interruptFn({ keepResponse: true, keepFlee: true })
    // Prepend attack to front of queue instead of replacing, and launch it now — left
    // to the engine it would wait for the next tick, up to 5s of free hits.
    setTimeout(() => {
      state.actionQueue.unshift({ actionStr: action, username: 'auto' })
      require('./engine').processActionQueue()
    }, T.QUEUE_PREPEND_DELAY)
    return true
  }

  // --- DEFEND MODE (opt-in, !defend on): strike a hostile on sight, before it hits ---
  const defend = require('./defendMode')
  const { scanHostiles } = require('./guard')
  let defendTicks = 0
  bot.on('physicsTick', () => {
    if (++defendTicks % 5 || !defend.isOn() || bot.melee.target) return
    const hostile = scanHostiles(defend.DEFEND_RANGE)
    if (!hostile) return
    autoFight(hostile, `defend: ${hostile.name} at ${hostile.position.distanceTo(bot.entity.position).toFixed(1)}m`,
      `${hostile.name || 'Hostile'} spotted, engaging!`)
  })

  // --- DAMAGE RESPONSE ---
  let lastEnvDamage = 0
  let lastEnvCause = null, lastEnvJournal = 0
  bot.on('entityHurt', (entity, source, damageType) => {
    if (entity !== bot.entity) return

    // A projectile: the guard knows what it was, where it came from and who shot it,
    // at any range. Fight back if the shooter is a mob.
    const shot = require('./projectileGuard').takeShot()
    if (shot) {
      const s = shot.shooter
      const fought = s && !s.username && (s.type === 'hostile' || s.type === 'mob') &&
        autoFight(s, `hit by ${shot.text}`, `Hit by a ${shot.name} from ${shot.from}!`)
      if (!fought) {
        console.log(`  [AUTO] hit by ${shot.text}, HP=${Math.round(bot.health)}`)
        require('../core/utils').logEvent(`hit by ${shot.text}`)
      }
      return
    }

    // The server names who did it (damage_event, 1.19.4+), and mineflayer passes it
    // on as source. Fight back if it's a mob, as for a projectile's shooter.
    if (source?.isValid && source !== bot.entity) {
      const name = source.username || source.name || source.displayName
      const fought = !source.username && (source.type === 'hostile' || source.type === 'mob') &&
        autoFight(source, `attacked by ${name}!`, `Under attack by ${name}!`)
      if (!fought) {
        console.log(`  [AUTO] hit by ${name}, HP=${Math.round(bot.health)}`)
        require('../core/utils').logEvent(`hit by ${name}`)
      }
      return
    }

    // No source (older versions send none): guess a nearby hostile attacker.
    // An archer hits from range: one in sight counts too.
    // A neutral mob (enderman) standing by is the attacker only if nothing else is.
    // A fall, lava or suffocation has no attacker: don't pin it on a mob standing by.
    const { isNeutral } = require('../perception/entityClass')
    const near = (e) => (e.type === 'hostile' || e.type === 'mob') && e.position.distanceTo(bot.entity.position) < 6
    const attacker = hasAttacker(damageType) && (bot.nearestEntity(e => near(e) && !isNeutral(e)) ||
      ranged.nearestArcher(bot) || bot.nearestEntity(near))

    if (attacker) {
      autoFight(attacker, `attacked by ${attacker.name || attacker.displayName}!`, `Under attack by ${attacker.name || 'something'}!`)
      return
    }

    // Environmental damage. The model hears what it was (or that nothing named it), so
    // it doesn't blame whatever is near; once per cause per debounce window, since
    // suffocating or burning hurts every half second.
    const cause = damageCause(damageType)
    const now = Date.now()
    if (cause !== lastEnvCause || now - lastEnvJournal >= T.ENV_DAMAGE_DEBOUNCE) {
      require('../core/utils').logEvent(`hurt by ${cause}`)
      lastEnvCause = cause
      lastEnvJournal = now
    }
    if (now - lastEnvDamage < T.ENV_DAMAGE_DEBOUNCE) return
    lastEnvDamage = now

    const pos = bot.entity.position
    const feetBlock = bot.blockAt(pos.offset(0, 0, 0))
    const belowBlock = bot.blockAt(pos.offset(0, -1, 0))
    const inFire = feetBlock && FIRE_BLOCKS.has(feetBlock.name)
    const inLava = feetBlock && (feetBlock.name === 'lava')
    const onCactus = belowBlock && belowBlock.name === 'cactus'
    const onMagma = belowBlock && belowBlock.name === 'magma_block'
    const vel = bot.entity.velocity
    const burning = (bot.entity.metadata?.[0] & 1) === 1   // shared flags: on fire
    const wasFall = damageType ? damageType === 'fall'
      : vel && vel.y > -0.1 && !inFire && !inLava && !onCactus && !onMagma && !burning && bot.oxygenLevel > OXYGEN_FALL_SAFE

    if (inLava) {
      console.log(`  [AUTO] LAVA DAMAGE! HP=${Math.round(bot.health)}, fleeing`)
      interruptFn({ keepResponse: true, keepFlee: true })
      const escapeLava = async () => {
        bot.setControlState('jump', true)
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        await sleep(2000)
        bot.setControlState('jump', false)
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
      }
      escapeLava().catch(err => {
        console.error('  [AUTO] escapeLava error:', err.message)
        try {
          bot.setControlState('jump', false)
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
        } catch(e) {}
      })
    } else if (inFire) {
      console.log(`  [AUTO] ON FIRE! HP=${Math.round(bot.health)}, moving away`)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      setTimeout(() => {
        try {
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
        } catch(e) {}
      }, 1500)
    } else if (onCactus) {
      console.log(`  [AUTO] cactus damage, stepping away`)
      bot.setControlState('back', true)
      setTimeout(() => { try { bot.setControlState('back', false) } catch(e) {} }, 500)
    } else if (burning) {
      console.log(`  [AUTO] burning, HP=${Math.round(bot.health)}`)
    } else if (wasFall) {
      console.log(`  [AUTO] fall damage, HP=${Math.round(bot.health)}`)
    } else {
      console.log(`  [AUTO] environmental damage: ${cause}, HP=${Math.round(bot.health)}, block=${feetBlock?.name}`)
    }
  })

  // --- AUTO-PICKUP items when idle ---
  // Only drops the bot can SEE (bot.entities also lists items behind walls — using
  // those would be x-ray) and can walk STRAIGHT to through passable blocks: this is a
  // reflex for loose items at arm's length, not a navigation job. Anything else is
  // left to the model. As a last resort, one trip per item: a drop still there
  // afterwards is skipped for good — retrying it forever turns an idle bot into a nav
  // loop that nothing, not even `stop`, can end, since this is no action.
  let pickupBusy = false
  const unreachableDrops = new Set()  // entity ids
  const pickupInterval = setInterval(async () => {
    const { isBackgroundRunning } = require('./backgroundTask')
    if (!bot?.entity || state.currentTask || isBackgroundRunning() || pickupBusy) return
    if (Date.now() < (state.pickupPausedUntil || 0)) return  // just gave something away
    try {
      const { hasLineOfSight, rayReachable } = require('../perception/vision')
      const pos = bot.entity.position
      const eye = pos.offset(0, 1.62, 0), body = pos.offset(0, 0.5, 0)
      const near = Object.values(bot.entities).filter(e =>
        e.name === 'item' && !unreachableDrops.has(e.id) && e.position.distanceTo(pos) < 3 &&
        hasLineOfSight(eye, e.position, 0.25) && rayReachable(body, e.position.offset(0, 0.1, 0))
      )
      if (near.length > 0) {
        const c = near[0]
        pickupBusy = true
        const { navigateTo } = require('../navigation/navigation')
        const { dropGoal, closeIn } = require('../actions/pickup')
        const g = dropGoal(c)
        await navigateTo(g.x, g.y, g.z, g.range, T.PICKUP_NAV_TIMEOUT).catch(() => {})
        // The walk can end short of pickup range (see pickup.js): closeIn takes the last
        // step. The server hands the item over a tick or more after the hitboxes touch.
        // Wait for that.
        await closeIn(c).catch(() => {})
        for (let t = 0; t < T.PICKUP_SETTLE && bot.entities[c.id]; t += 50) await sleep(50)
        if (bot.entities[c.id]) {
          unreachableDrops.add(c.id)
          console.log(`  [AUTO] pickup: drop #${c.id} still there after one trip, giving up on it`)
        }
        pickupBusy = false
      }
    } catch (e) { pickupBusy = false }
  }, T.PICKUP_INTERVAL)
  bot.once('end', () => clearInterval(pickupInterval))
}

module.exports = { setupAutonomous }
