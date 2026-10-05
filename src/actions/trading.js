// Trading — a villager's or wandering trader's offers.
//   trade:villager#41f1          open its trade window and report the offers, numbered
//   trade:villager#41f1:2[:N]    make offer 2, N times (default 1)
// A villager without a profession (or a nitwit, or a baby) has no offers: its window
// never opens, so that is checked first instead of waiting on a window.
const state = require('../core/state')
const { stopAll, raceAbort, sleep } = require('../core/tick')
const { navigateTo } = require('../navigation/navigation')
const { sendChat, recordFailure, logEvent, fuzzyMatch } = require('../core/utils')
const { entityTag, tagOf, findTagged } = require('../perception/entityTag')

// villager_data's profession is an index into the registry, which minecraft-data
// doesn't ship; vanilla's order (none first, then alphabetical).
const PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher',
  'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith']
const TRADERS = ['villager', 'wandering_trader']
const OPEN_TIMEOUT = 5000

function profession(bot, e) {
  if (e.name !== 'villager') return null
  const idx = bot.registry.entitiesByName.villager.metadataKeys.indexOf('villager_data')
  const d = e.metadata?.[idx]
  return d ? { name: PROFESSIONS[d.villagerProfession] || `profession ${d.villagerProfession}`, level: d.level } : null
}

function isBaby(bot, e) {
  const idx = bot.registry.entitiesByName[e.name]?.metadataKeys?.indexOf('baby')
  return idx >= 0 && e.metadata?.[idx] === true
}

const stack = (it, n) => `${n ?? it.count} ${it.name}`

function describeOffer(bot, t, i) {
  const price = t.realPrice ?? t.inputItem1.count
  const give = [stack(t.inputItem1, price), t.inputItem2 && stack(t.inputItem2)].filter(Boolean).join(' + ')
  const afford = bot.inventory.count(t.inputItem1.type) >= price &&
    (!t.inputItem2 || bot.inventory.count(t.inputItem2.type) >= t.inputItem2.count)
  const stock = t.tradeDisabled ? 'SOLD OUT' : `${t.nbTradeUses}/${t.maximumNbTradeUses} used`
  return `${i + 1}) ${give} → ${stack(t.outputItem)} [${stock}${afford ? ', can afford' : ''}]`
}

function invCounts(bot) {
  const m = {}
  for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count
  return m
}

async function doTrade(target) {
  stopAll()
  const bot = state.bot
  const [who, offerStr, timesStr] = (target || 'villager').split(':')
  state.currentTask = `trading with ${who}`
  const fail = (msg) => { sendChat(msg); recordFailure(`trade:${target} - ${msg}`); state.currentTask = null; return false }

  const entity = tagOf(who) ? findTagged(who) : bot.nearestEntity(e =>
    TRADERS.includes(e.name) && fuzzyMatch(e.name, who.toLowerCase()))
  if (!entity || !TRADERS.includes(entity.name)) return fail(`No ${who} nearby to trade with`)
  const tag = entityTag(entity)

  const prof = profession(bot, entity)
  if (prof?.name === 'none') return fail(`${tag} has no profession, so no trades. It takes a job from an unclaimed job block it can reach (fletching_table → fletcher, lectern → librarian, …)`)
  if (prof?.name === 'nitwit') return fail(`${tag} is a nitwit, it never trades`)
  if (isBaby(bot, entity)) return fail(`${tag} is a baby, it can't trade yet`)

  if (bot.entity.position.distanceTo(entity.position) > 2.5) {
    await navigateTo(entity.position.x, entity.position.y, entity.position.z, 2, 15000, { reachTarget: () => entity?.position })
  }
  if (!entity.isValid) return fail(`${tag} is gone`)
  if (bot.entity.position.distanceTo(entity.position) > 3) return fail(`Couldn't get within reach of ${tag}`)

  await bot.lookAt(entity.position.offset(0, (entity.height || 1.95) * 0.85, 0), true)
  let win
  const opening = bot.openVillager(entity)
  try {
    win = await raceAbort(opening, OPEN_TIMEOUT)
  } catch (e) {
    opening.then(w => w.close()).catch(() => {})   // if it opens after all, don't leave it open
    if (e.name === 'AbortError') throw e
    return fail(`${tag} didn't open its trades (${e.message})`)
  }
  const trades = win.trades || []
  const who2 = prof ? `${tag} (${prof.name}, level ${prof.level})` : tag
  try {
    if (!offerStr) {
      const list = trades.map((t, i) => describeOffer(bot, t, i)).join(' | ') || 'nothing'
      logEvent(`trade: ${who2} offers ${list}`)
      console.log(`  [TRADE] ${who2} offers ${list}`)
      sendChat(`${tag} has ${trades.length} offer${trades.length === 1 ? '' : 's'}.`)
      return true
    }
    const n = parseInt(offerStr, 10)
    const times = Math.max(1, parseInt(timesStr, 10) || 1)
    const t = trades[n - 1]
    if (!t) return fail(`${tag} has no offer ${offerStr} (it has ${trades.length})`)
    if (t.tradeDisabled) return fail(`${tag}'s offer ${n} is sold out`)
    const before = invCounts(bot)
    try {
      await raceAbort(bot.trade(win, n - 1, times), 10000)
    } catch (e) {
      if (e.name === 'AbortError') throw e
      return fail(`Trade failed: ${e.message} (${describeOffer(bot, t, n - 1)})`)
    }
    win.close(); win = null
    await sleep(500)   // the inventory only syncs once the window is closed
    const after = invCounts(bot)
    const diff = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .map(k => [k, (after[k] || 0) - (before[k] || 0)]).filter(([, d]) => d)
      .map(([k, d]) => `${d > 0 ? '+' : ''}${d} ${k}`).join(', ')
    logEvent(`trade: offer ${n} x${times} with ${who2}: ${diff || 'no change'}`)
    console.log(`  [TRADE] offer ${n} x${times} with ${tag}: ${diff || 'no change'}`)
    if (!diff) return fail(`Traded with ${tag} but nothing changed in my inventory`)
    sendChat(`Traded with ${tag}: ${diff}`)
    return true
  } finally {
    if (win) win.close()
    state.currentTask = null
  }
}

module.exports = { doTrade }
