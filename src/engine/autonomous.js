// Autonomous behaviors — health, drowning, damage, idle pickup
const state = require('../core/state')
const { sleep } = require('../core/tick')
const { sendChat } = require('../core/utils')
const { HEALTH_AUTOEAT, FOOD_FULL, OXYGEN_DROWNING, OXYGEN_FALL_SAFE } = require('../config/safety')
const { WATER_BLOCKS, FIRE_BLOCKS } = require('../config/blocks')
const T = require('../config/timings')
const { entityTag } = require('../perception/entityTag')

function setupAutonomous(interruptFn) {
  const bot = state.bot
  const ranged = require('./rangedDefense')
  ranged.setupRangedDefense()
  require('./retreat').setupRetreat(interruptFn)

  // --- AUTO-EAT on low health ---
  bot.on('health', () => {
    if (bot.health <= HEALTH_AUTOEAT && bot.food < FOOD_FULL && !state.retreating) {
      const { edibleFoods } = require('../actions/vitals')
      // One eat at a time: 'health' fires on every HP/food change.
      const eating = state.backgroundTask?.action === 'eat' || state.actionQueue.some(a => a.actionStr === 'eat')
      if (edibleFoods(bot).length > 0 && !eating) {
        console.log(`  [AUTO] HP=${Math.round(bot.health)}, eating`)
        interruptFn()
        // Prepend eat to front of queue instead of replacing
        setTimeout(() => {
          state.actionQueue.unshift({ actionStr: 'eat', username: 'auto' })
        }, T.QUEUE_PREPEND_DELAY)
      }
    }
  })

  // --- DROWNING PROTECTION ---
  // No hard interrupt — just queue swimup. Hard interrupt kills API calls and
  // causes an unresponsive loop where the bot can never complete a response.
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
      // Queue swimup without interrupting — engine will process it
      state.actionQueue.unshift({ actionStr: 'swimup', username: 'auto' })
    }
  })

  // --- AUTO-FIGHT: interrupt whatever runs and put an attack at the front ---
  // No cooldown between fights: the next hostile is engaged as soon as pvp drops the
  // last one. Only an attack still launching (target alive) holds off a second one.
  let pending = null, pendingAt = 0
  function autoFight(attacker, logLine, chatLine) {
    // Running from a swarm (the reflex or a flee action) beats turning to fight.
    if (bot.pvp.target || state.retreating || state.currentTask === 'fleeing') return
    if (pending?.isValid && Date.now() - pendingAt < T.AUTOFIGHT_LAUNCH_GRACE) return
    pending = attacker; pendingAt = Date.now()
    console.log(`  [AUTO] ${logLine}`)
    require('../core/utils').logEvent(`reflex: ${logLine} → attack:${entityTag(attacker)}`)
    sendChat(chatLine)
    interruptFn()
    // Prepend attack to front of queue instead of replacing, and launch it now — left
    // to the engine it would wait for the next tick, up to 5s of free hits.
    setTimeout(() => {
      state.actionQueue.unshift({ actionStr: `attack:${entityTag(attacker)}`, username: 'auto' })
      require('./engine').processActionQueue()
    }, T.QUEUE_PREPEND_DELAY)
  }

  // --- DEFEND MODE (opt-in, !defend on): strike a hostile on sight, before it hits ---
  const defend = require('./defendMode')
  const { scanHostiles } = require('./guard')
  let defendTicks = 0
  bot.on('physicsTick', () => {
    if (++defendTicks % 5 || !defend.isOn() || bot.pvp.target) return
    const hostile = scanHostiles(defend.DEFEND_RANGE)
    if (!hostile) return
    autoFight(hostile, `defend: ${hostile.name} at ${hostile.position.distanceTo(bot.entity.position).toFixed(1)}m`,
      `${hostile.name || 'Hostile'} spotted, engaging!`)
  })

  // --- DAMAGE RESPONSE ---
  let lastEnvDamage = 0
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return

    // Check for nearby hostile attacker (mineflayer doesn't provide source)
    // An archer hits from range: one in sight counts too.
    const attacker = bot.nearestEntity(e =>
      (e.type === 'hostile' || e.type === 'mob') &&
      e.position.distanceTo(bot.entity.position) < 6
    ) || ranged.nearestArcher(bot)

    if (attacker) {
      autoFight(attacker, `attacked by ${attacker.name || attacker.displayName}!`, `Under attack by ${attacker.name || 'something'}!`)
      return
    }

    // Environmental damage: no hostile nearby
    if (Date.now() - lastEnvDamage < T.ENV_DAMAGE_DEBOUNCE) return
    lastEnvDamage = Date.now()

    const pos = bot.entity.position
    const feetBlock = bot.blockAt(pos.offset(0, 0, 0))
    const belowBlock = bot.blockAt(pos.offset(0, -1, 0))
    const inFire = feetBlock && FIRE_BLOCKS.has(feetBlock.name)
    const inLava = feetBlock && (feetBlock.name === 'lava')
    const onCactus = belowBlock && belowBlock.name === 'cactus'
    const onMagma = belowBlock && belowBlock.name === 'magma_block'
    const vel = bot.entity.velocity
    const wasFall = vel && vel.y > -0.1 && !inFire && !inLava && !onCactus && !onMagma && bot.oxygenLevel > OXYGEN_FALL_SAFE

    if (inLava) {
      console.log(`  [AUTO] LAVA DAMAGE! HP=${Math.round(bot.health)}, fleeing`)
      interruptFn()
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
    } else if (wasFall) {
      console.log(`  [AUTO] fall damage, HP=${Math.round(bot.health)}`)
    } else {
      console.log(`  [AUTO] environmental damage, HP=${Math.round(bot.health)}, block=${feetBlock?.name}`)
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
        await navigateTo(Math.floor(c.position.x), Math.floor(c.position.y), Math.floor(c.position.z), 1, T.PICKUP_NAV_TIMEOUT).catch(() => {})
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
