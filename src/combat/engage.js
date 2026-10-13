// How the reflexes answer a mob: melee when the bot can get within reach of it on
// foot, else a ranged weapon it can spend on it, else nothing (the model hears why).
// A ghast 20m up, or a skeleton across a ravine, used to get a melee chase that
// gave up after a few seconds of free hits.
const { MinHeap, _pNeighbors } = require('../navigation/pathplanner')
const { _pKnownSolid, _pSurface } = require('../navigation/blockquery')
const { nearBlock } = require('../navigation/goals')
const { entityTag } = require('../perception/entityTag')
const { enchantLevel, ammoCount } = require('../actions/ranged')

// Melee lands within ~3 blocks of the eye; a mob this close is in reach already.
const CLOSE = 4
// A standing spot this close to the mob's feet puts its hitbox in reach.
const STAND_RANGE = 4
const PLAN_NODES = 3000
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

// Can the bot walk to a spot within reach of the mob? `seen`: only over floor it has
// seen. Otherwise unseen floor counts as solid, as when navigating, which walks out
// into the sky off a ledge. Either way the spot must be within reach in 3D: the
// planner's own arrival (the mob's column at any height) took a spot 7 below a ghast
// for reach.
function meleeReachable(bot, mob, { seen = true } = {}) {
  const p = bot.entity.position
  if (p.distanceTo(mob.position) <= CLOSE) return true
  const t = mob.position.floored()
  const key = (x, y, z) => `${x},${y},${z}`
  const start = { x: Math.floor(p.x), y: Math.round(p.y), z: Math.floor(p.z) }
  const h = (n) => Math.abs(n.x - t.x) + Math.abs(n.y - t.y) + Math.abs(n.z - t.z)
  const open = new MinHeap()
  const g = new Map([[key(start.x, start.y, start.z), 0]])
  open.push({ ...start, f: h(start) })
  for (let expanded = 0; open.length && expanded < PLAN_NODES; expanded++) {
    const cur = open.pop()
    if (nearBlock(cur.x, cur.y, cur.z, t.x, t.y, t.z, STAND_RANGE)) return true
    const cg = g.get(key(cur.x, cur.y, cur.z))
    for (const n of _pNeighbors(cur.x, cur.y, cur.z, 'walk', null)) {
      if (seen && !_pKnownSolid(n.x, n.y - 1, n.z) && !_pSurface(n.x, n.y, n.z)) continue
      const nk = key(n.x, n.y, n.z), ng = cg + n.cost
      if (g.has(nk) && g.get(nk) <= ng) continue
      g.set(nk, ng)
      open.push({ x: n.x, y: n.y, z: n.z, f: ng + h(n) })
    }
  }
  return false
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
  if (!r.weapon) {
    // Nothing to shoot with: chase over ground not seen yet, if that may lead there.
    if (meleeReachable(bot, mob, { seen: false })) return { action: `attack:${tag}`, why: `maybe in reach on foot, and ${r.why}` }
    return { action: null, why: `out of reach on foot, and ${r.why}` }
  }
  const { hasLineOfSight } = require('../perception/vision')
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  if (!hasLineOfSight(eye, mob.position, mob.height || 1.8)) return { action: null, why: 'out of reach on foot and out of sight' }
  return { action: `shoot:${tag}:${r.weapon}`, why: `out of reach on foot${r.short ? `; short of arrows (${r.short})` : ''}` }
}

module.exports = { chooseEngagement, meleeReachable, rangedChoice }
