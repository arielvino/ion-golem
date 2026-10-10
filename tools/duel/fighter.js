// One duelist: a mineflayer client (no AI, no chat) run as a child of the referee.
// The referee says when a round starts and stops; the strategy module does the
// fighting, and may call the bot's real actions (doAttack, doShoot): this client is
// installed as state.bot, and a round's end aborts them through state.abortSignal.
// Each fighter is its own process so neither can starve the other's physics loop.
//
//   node tools/duel/fighter.js <username> <strategy>
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
const state = require('../../src/core/state')

const [username, strategyName] = process.argv.slice(2)
const strategy = require(path.join(__dirname, 'strategies', strategyName))

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  version: process.env.MC_VERSION || '26.3',
  username
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(pvp)
state.bot = bot
state.chatMuted = true

const send = (msg) => process.send && process.send(msg)
let round = null   // { controller, opponents, hitsDealt, hitsTaken }

// DUEL_PROBE=1 prints each pathfinder result and, every second, where both fighters are.
const PROBE = !!process.env.DUEL_PROBE
bot.on('path_update', (r) => { if (PROBE) console.log('PATH', username, r.status, 'len', r.path.length, 'visited', r.visitedNodes) })
bot.once('spawn', () => {
  // The arena's cover is part of the fight: don't let the pathfinder dig through it.
  bot.pvp.movements.canDig = false
  bot.pvp.movements.allow1by1towers = false
  // The bot's physicsTick reflexes against archers and incoming projectiles.
  require('../../src/engine/rangedDefense').setupRangedDefense()
  require('../../src/engine/projectileGuard').setupProjectileGuard()
})

bot.on('entityHurt', (e) => {
  if (!round) return
  if (e === bot.entity) round.hitsTaken++
  else if (round.opponents.includes(e.username)) round.hitsDealt++
})

bot.on('death', () => {
  if (round) send({ type: 'died', hp: 0, ...stats() })
  halt()
})
bot.on('spawn', () => { if (!round) send({ type: 'ready' }) })

function stats() {
  return { hitsDealt: round?.hitsDealt || 0, hitsTaken: round?.hitsTaken || 0, hp: bot.health, food: bot.food }
}

function halt() {
  if (!round) return
  round.controller.abort()
  round = null
  state.abortSignal = true
  try { bot.pvp.forceStop() } catch (e) {}
  try { bot.pathfinder.stop() } catch (e) {}
  bot.clearControlStates()
  try { bot.deactivateItem() } catch (e) {}
}

setInterval(() => {
  if (!round || !PROBE) return
  const e = require('./strategies/common').nearestOpponent(bot, round.opponents)
  console.log('PROBE', username, bot.entity.position.toString(), 'hp', bot.health, 'opp', e ? e.position.toString() : 'none',
    'pvpTarget', !!bot.pvp.target, 'moving', bot.pathfinder.isMoving(),
    'dist', e ? e.position.distanceTo(bot.entity.position).toFixed(2) : '-')
}, 1000)

process.on('message', async (msg) => {
  if (msg.type === 'start') {
    halt()
    const controller = new AbortController()
    round = { controller, opponents: msg.opponents, hitsDealt: 0, hitsTaken: 0 }
    state.abortSignal = false
    try {
      await strategy.run(bot, { opponents: msg.opponents, signal: controller.signal })
    } catch (e) {
      if (!controller.signal.aborted && e.name !== 'AbortError') console.error(`[${username}] strategy error:`, e)
    }
  } else if (msg.type === 'stop') {
    const s = stats()
    halt()
    send({ type: 'stats', ...s })
  } else if (msg.type === 'quit') {
    halt()
    bot.quit()
    setTimeout(() => process.exit(0), 500)
  }
})

bot.on('kicked', (r) => { console.error(`[${username}] kicked:`, r); process.exit(1) })
bot.on('error', (e) => console.error(`[${username}] error:`, e.message))
bot.on('end', () => process.exit(0))
