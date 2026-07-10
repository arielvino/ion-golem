// Autonomous behaviors — health, drowning, damage, idle pickup
const state = require('../core/state')
const { sleep } = require('../core/tick')
const { sendChat } = require('../core/utils')
const { HEALTH_AUTOEAT, OXYGEN_DROWNING, OXYGEN_FALL_SAFE } = require('../config/safety')
const { WATER_BLOCKS, FIRE_BLOCKS } = require('../config/blocks')
const T = require('../config/timings')

function setupAutonomous(interruptFn) {
  const bot = state.bot

  // --- AUTO-EAT on low health ---
  bot.on('health', () => {
    if (bot.health <= HEALTH_AUTOEAT) {
      const foods = bot.inventory.items().filter(i => i.foodRecovery > 0)
      if (foods.length > 0 && !state.currentTask?.includes('eating')) {
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

  // --- DAMAGE RESPONSE ---
  let lastAutoFight = 0
  let lastEnvDamage = 0
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return

    // Check for nearby hostile attacker (mineflayer doesn't provide source)
    const attacker = bot.nearestEntity(e =>
      (e.type === 'hostile' || e.type === 'mob') &&
      e.position.distanceTo(bot.entity.position) < 6
    )

    if (attacker) {
      if (Date.now() - lastAutoFight < T.AUTOFIGHT_DEBOUNCE) return
      if (bot.pvp.target) return
      lastAutoFight = Date.now()
      console.log(`  [AUTO] attacked by ${attacker.name || attacker.displayName}!`)
      sendChat(`Under attack by ${attacker.name || 'something'}!`)
      interruptFn()
      // Prepend attack to front of queue instead of replacing
      setTimeout(() => {
        state.actionQueue.unshift({ actionStr: `attack:${attacker.name}`, username: 'auto' })
      }, T.QUEUE_PREPEND_DELAY)
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
  let pickupBusy = false
  const pickupInterval = setInterval(async () => {
    const { isBackgroundRunning } = require('./backgroundTask')
    if (!bot?.entity || state.currentTask || isBackgroundRunning() || pickupBusy) return
    try {
      const near = Object.values(bot.entities).filter(e =>
        e.name === 'item' && e.position.distanceTo(bot.entity.position) < 3
      )
      if (near.length > 0) {
        const c = near[0]
        pickupBusy = true
        const { navigateTo } = require('../navigation/navigation')
        await navigateTo(Math.floor(c.position.x), Math.floor(c.position.y), Math.floor(c.position.z), 1, T.PICKUP_NAV_TIMEOUT).catch(() => {})
        pickupBusy = false
      }
    } catch (e) { pickupBusy = false }
  }, T.PICKUP_INTERVAL)
  bot.once('end', () => clearInterval(pickupInterval))
}

module.exports = { setupAutonomous }
