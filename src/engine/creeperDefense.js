// creeperDefense.js — reflex against a creeper's fuse.
//
// A creeper starts its 1.5s fuse once within ~3 blocks of its target and calls it
// off beyond ~7. Its swell_dir metadata goes to 1 when the fuse starts. Then:
//   - shield in the off-hand: stand, face the creeper and block. A raised shield
//     takes the whole blast if it comes from in front, so with a shield the creeper
//     is lured in, not avoided. Keep it a step away: pvp's own creeper block
//     (checkExplosion) keeps following its target and walks the bot into the
//     creeper, where the blast centre is on top of it and "in front" is a toss-up;
//   - no shield: hit and run. Sprint out of range until the fuse is called off,
//     then pvp walks back in for the next hit.
// pvp is held off its swings meanwhile via its blockingExplosion flag.
const state = require('../core/state')
const { goals } = require('mineflayer-pathfinder')

const FUSE_RANGE = 8         // a fusing creeper this close is answered
const SAFE_DIST = 7.5        // evading ends past this, once the fuse is off
const BLOCK_DIST = 2.5       // while blocking, back off if it's closer than this
const EXPLODED_MS = 3000     // an exploded creeper stays known this long

function fusing(bot, e) {
  const idx = bot.registry.entitiesByName.creeper?.metadataKeys?.indexOf('swell_dir')
  return idx >= 0 && e.metadata?.[idx] === 1
}

const exploded = new Map()   // creeper id → ms it blew up
function didExplode(e) { return exploded.has(e.id) }

function setupCreeperDefense() {
  const bot = state.bot
  const { logEvent } = require('../core/utils')
  const { entityTag } = require('../perception/entityTag')
  const hasShield = () => bot.inventory.slots[45]?.name === 'shield'
  let mode = null            // { creeper, kind: 'block' | 'evade', hp, tag }
  const lastFusing = new Map()  // creeper id → { pos, at }

  // A fusing creeper that vanishes right as an explosion goes off there blew up.
  bot._client.on('explosion', (p) => {
    const c = p.center || p
    for (const [id, f] of lastFusing) {
      if (Math.hypot(f.pos.x - c.x, f.pos.y - c.y, f.pos.z - c.z) < 3) exploded.set(id, Date.now())
    }
  })

  const finish = (outcome) => {
    const { kind, hp, tag } = mode
    if (kind === 'block' && !bot.pvp?.target) bot.deactivateItem()
    for (const c of ['forward', 'sprint', 'back']) bot.setControlState(c, false)
    // Back to the fight: pvp re-follows its target (we cleared its goal).
    if (bot.pvp?.target?.isValid) bot.pathfinder.setGoal(new goals.GoalFollow(bot.pvp.target, bot.pvp.followRange), true)
    if (bot.pvp) bot.pvp.blockingExplosion = false
    const lost = Math.max(0, hp - bot.health)
    const did = kind === 'block' ? 'blocked with shield' : 'ran from'
    logEvent(`reflex: ${did} ${tag}'s fuse → ${outcome}${lost ? `, took ${Math.round(lost)} damage` : ', no damage'}`)
    console.log(`  [CREEPER] ${kind} over: ${outcome}, HP ${Math.round(hp)}→${Math.round(bot.health)}`)
    state.creeperReflex = false
    mode = null
  }

  bot.on('death', () => {
    if (!mode) return
    logEvent(`reflex: ${mode.kind === 'block' ? 'blocked with shield' : 'ran from'} ${mode.tag}'s fuse → it killed me`)
    state.creeperReflex = false
    mode = null
  })

  bot.on('physicsTick', () => {
    if (!bot.entity || bot.health <= 0) return
    const now = Date.now()
    for (const [id, at] of exploded) if (now - at > EXPLODED_MS) exploded.delete(id)
    const pos = bot.entity.position

    const lit = bot.nearestEntity(e => e.name === 'creeper' && fusing(bot, e) && e.position.distanceTo(pos) < FUSE_RANGE)
    for (const [id, f] of lastFusing) if (now - f.at > 1000) lastFusing.delete(id)
    if (lit) lastFusing.set(lit.id, { pos: lit.position.clone(), at: now })

    if (mode) {
      const c = mode.creeper
      if (!c.isValid) return finish(didExplode(c) ? 'it exploded' : 'it died')
      const d = c.position.distanceTo(pos)
      if (mode.kind === 'block') {
        if (!fusing(bot, c)) return finish('fuse called off')
        bot.pvp.blockingExplosion = true
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)   // a fresh pvp.attack sets one
        bot.setControlState('forward', false)
        bot.setControlState('back', d < BLOCK_DIST)
        bot.lookAt(c.position.offset(0, 1, 0), true).catch(() => {})
        // Something else lowered it (server says hand not active): raise it again.
        if (!(bot.entity.metadata?.[8] & 1) && now - mode.raisedAt > 300) { bot.activateItem(true); mode.raisedAt = now }
        return
      }
      // evade
      if (!fusing(bot, c) && d >= SAFE_DIST) return finish('fuse called off')
      bot.pvp.blockingExplosion = true
      if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
      const { escapeDir } = require('./retreat')
      const dir = escapeDir(bot, [c]) || { dx: pos.x - c.position.x, dz: pos.z - c.position.z }
      bot.look(Math.atan2(-dir.dx, -dir.dz), 0, true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      return
    }

    if (!lit) return
    const tag = entityTag(lit)
    bot.pathfinder.setGoal(null)
    if (bot.pvp) bot.pvp.blockingExplosion = true
    state.creeperReflex = true
    if (hasShield()) {
      bot.lookAt(lit.position.offset(0, 1, 0), true).catch(() => {})
      bot.activateItem(true)
      mode = { creeper: lit, kind: 'block', hp: bot.health, tag, raisedAt: now }
      console.log(`  [CREEPER] ${tag} fusing at ${lit.position.distanceTo(pos).toFixed(1)}m, shield up`)
    } else {
      mode = { creeper: lit, kind: 'evade', hp: bot.health, tag }
      console.log(`  [CREEPER] ${tag} fusing at ${lit.position.distanceTo(pos).toFixed(1)}m, no shield, running`)
    }
  })
}

module.exports = { setupCreeperDefense, didExplode }
