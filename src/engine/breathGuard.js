// breathGuard.js — reflex against the ender dragon's breath.
//
// The dragon's fireball and its perched flame leave a cloud of dragon's breath on
// the ground: an area_effect_cloud with the dragon_breath particle that deals
// Instant Damage II every second to whatever stands in it, for up to 30s, while
// its radius grows (to 7 for a fireball). Nothing else tells the bot about it: the
// hurt arrives as plain indirect magic with no block or attacker to blame, so it
// stood there until it died.
//
// The cloud is a flat cylinder: its radius horizontally, 0.5 tall from its y. When
// the bot's hitbox is in one (plus a margin), sprint until well clear of the edge,
// away from every cloud at once, along known safe floor (retreat's escapeDir reads
// the block DB, so it won't run off the island). Melee, the fight reflex and the
// swarm retreat stand down meanwhile, as for a creeper's fuse.
const state = require('../core/state')
const { goals } = require('mineflayer-pathfinder')

const MARGIN = 1.0           // this close to the cloud's edge counts as in it
const CLEAR = 3.0            // a run ends this far past the edge: the radius grows
const MAX_ESCAPE_MS = 8000   // then give up the run (cornered, or it keeps up)

function radius(bot, e) {
  const idx = bot.registry.entitiesByName.area_effect_cloud?.metadataKeys?.indexOf('radius')
  const r = idx >= 0 ? e.metadata?.[idx] : null
  return typeof r === 'number' ? r : 3
}

function isBreath(bot, e) {
  if (e.name !== 'area_effect_cloud') return false
  const idx = bot.registry.entitiesByName.area_effect_cloud?.metadataKeys?.indexOf('particle')
  return idx >= 0 && e.metadata?.[idx]?.type === 'dragon_breath'
}

// Breath clouds the bot's hitbox (1.8 tall from its feet) is in, with this margin.
function breathAround(bot, margin) {
  const pos = bot.entity.position
  return Object.values(bot.entities).filter(e => {
    if (!isBreath(bot, e)) return false
    const dy = pos.y - e.position.y
    if (dy >= 0.5 + margin || dy <= -1.8 - margin) return false
    return Math.hypot(pos.x - e.position.x, pos.z - e.position.z) < radius(bot, e) + margin
  })
}

function setupBreathGuard() {
  const bot = state.bot
  const { logEvent } = require('../core/utils')
  let run = null             // { at, hp, dir }
  let ticks = 0

  const stop = () => {
    for (const c of ['forward', 'sprint']) bot.setControlState(c, false)
    if (bot.melee) bot.melee.blockingExplosion = false
    state.breathReflex = false
  }

  const finish = (outcome) => {
    const lost = Math.max(0, run.hp - bot.health)
    stop()
    // Back to the fight: melee re-follows its target (we cleared its goal).
    if (bot.melee?.target?.isValid) bot.pathfinder.setGoal(new goals.GoalFollow(bot.melee.target, bot.melee.followRange), true)
    logEvent(`reflex: ran out of dragon's breath → ${outcome}${lost ? `, took ${Math.round(lost)} damage` : ', no damage'}`)
    console.log(`  [BREATH] over: ${outcome}, HP ${Math.round(run.hp)}→${Math.round(bot.health)}`)
    run = null
  }

  bot.on('death', () => {
    if (!run) return
    logEvent(`reflex: ran from dragon's breath → it killed me`)
    stop()
    run = null
  })

  bot.on('physicsTick', () => {
    if (!bot.entity || bot.health <= 0) return
    ticks++
    if (!run && ticks % 2) return
    const clouds = breathAround(bot, run ? CLEAR : MARGIN)
    if (!run) {
      if (!clouds.length) return
      run = { at: Date.now(), hp: bot.health, dir: null }
      state.breathReflex = true
      console.log(`  [BREATH] in ${clouds.length} dragon's breath cloud(s) (r=${clouds.map(c => radius(bot, c).toFixed(1)).join(',')}), HP=${Math.round(bot.health)}, running out`)
    } else {
      if (!clouds.length) return finish('clear')
      if (Date.now() - run.at > MAX_ESCAPE_MS) return finish('still in it, gave up')
    }

    if (bot.melee) bot.melee.blockingExplosion = true
    if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
    if (!run.dir || ticks % 4 === 0) {
      const { escapeDir } = require('./retreat')
      const pos = bot.entity.position
      const c = clouds[0].position
      run.dir = escapeDir(bot, clouds) || run.dir || { dx: pos.x - c.x, dz: pos.z - c.z }
    }
    bot.look(Math.atan2(-run.dir.dx, -run.dir.dz), 0, true).catch(() => {})
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
  })
}

module.exports = { setupBreathGuard }
