// How the reflexes answer a mob: melee when the bot can get within reach of it on
// foot, else a ranged weapon it can spend on it, else nothing (the model hears why).
// A ghast 20m up, or a skeleton across a ravine, used to get a melee chase that
// gave up after a few seconds of free hits.
const { goals } = require('mineflayer-pathfinder')
const { entityTag } = require('../perception/entityTag')
const { enchantLevel, ammoCount } = require('../actions/ranged')

// Melee lands within ~3 blocks of the eye; a mob this close is in reach already.
const CLOSE = 4
// How long the reach check may plan; past it, out of reach.
const PLAN_MS = 250
// Max health, for the arrow budget; anything unlisted is taken as 20.
const MAX_HP = {
  ghast: 10, vex: 14, bogged: 16, piglin: 16, spider: 16, cave_spider: 12, silverfish: 8,
  endermite: 8, pillager: 24, witch: 26, breeze: 30, shulker: 30, vindicator: 24,
  evoker: 24, enderman: 40, ravager: 100, hoglin: 40, zoglin: 40, piglin_brute: 50,
  elder_guardian: 80, guardian: 30, wither: 300, ender_dragon: 200
}
// Damage of one hit, and how many shots to budget per needed hit (misses).
const DMG = { bow: 6, crossbow: 9, trident: 8 }
const MISS_FACTOR = 2
// A thrown trident is slow and loopy: past this it mostly misses.
const TRIDENT_RANGE = 20

// Will the melee chase get within reach? Asked of the pathfinder the chase moves
// with, toward the goal it follows (GoalFollow: in reach in 3D, so not a spot 7
// below a ghast). The pathfinder plans over the live world, as it does for the chase.
function meleeReachable(bot, mob) {
  if (bot.entity.position.distanceTo(mob.position) <= CLOSE) return true
  const goal = bot.melee ? bot.melee.followGoal(mob) : new goals.GoalFollow(mob, 2)
  // Its own search, not getPathTo: that replaces the search a running chase continues.
  // The chase's own movements, even mid-walk: a walk's may bridge, a chase's don't.
  const movements = bot.movementsFor?.chase || bot.pathfinder.movements
  const search = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout: PLAN_MS })
  let result
  for (const step of search) result = step.result
  return result?.status === 'success'
}

// The ranged weapon to use on `mob`, or null with the reason. A Loyalty trident
// comes back, so it costs nothing; arrows are budgeted against the mob's health; a
// trident without Loyalty is thrown once and lost, so a reflex never throws it.
function rangedChoice(bot, mob) {
  const items = bot.inventory.items()
  const arrows = ammoCount(bot)
  const hp = MAX_HP[mob.name] ?? 20
  const need = (w) => Math.ceil(hp / DMG[w]) * MISS_FACTOR
  const dist = bot.entity.position.distanceTo(mob.position)
  const trident = items.find(i => i.name === 'trident' && enchantLevel(bot, i, 'loyalty') > 0 &&
    !enchantLevel(bot, i, 'riptide'))
  if (trident && dist <= TRIDENT_RANGE) return { weapon: 'trident' }
  const launchers = ['crossbow', 'bow'].filter(w => items.some(i => i.name === w))
  if (launchers.length && arrows) {
    // Enough arrows for one of them: that one (crossbow first, it hits harder); else
    // the one that needs fewest, short of arrows or not.
    const enough = launchers.find(w => arrows >= need(w))
    return { weapon: enough || launchers[0], short: !enough && `${arrows} arrows for ~${need(launchers[0])}` }
  }
  if (trident) return { weapon: 'trident' }
  if (launchers.length) return { weapon: null, why: `no arrows for the ${launchers.join(' or ')}` }
  if (items.some(i => i.name === 'trident')) return { weapon: null, why: 'only a trident without Loyalty, which would be lost' }
  return { weapon: null, why: 'no bow, crossbow or Loyalty trident' }
}

// { action, why }: the action string to queue, or action null and why not.
function chooseEngagement(bot, mob) {
  const tag = entityTag(mob)
  if (meleeReachable(bot, mob)) return { action: `attack:${tag}`, why: 'in reach on foot' }
  const r = rangedChoice(bot, mob)
  if (!r.weapon) return { action: null, why: `out of reach on foot, and ${r.why}` }
  const { hasLineOfSight } = require('../perception/vision')
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  if (!hasLineOfSight(eye, mob.position, mob.height || 1.8)) return { action: null, why: 'out of reach on foot and out of sight' }
  return { action: `shoot:${tag}:${r.weapon}`, why: `out of reach on foot${r.short ? `; short of arrows (${r.short})` : ''}` }
}

module.exports = { chooseEngagement, meleeReachable, rangedChoice }
