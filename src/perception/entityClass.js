// Sorts entities into the nearby= groups. Despawning ambient mobs (fish, squid,
// bats) come by the dozen and never matter one by one, so they are summarized;
// persistent mobs and threats keep their tags; drops keep coords but only in
// pickup range. Lists live in config/entities.json.
const cfg = require('../config/entities.json')
const state = require('../core/state')

const BACKGROUND = new Set(cfg.background)
const THREATS = new Set(cfg.threats)

// 'drop' | 'threat' | 'background' | 'tracked'
function entityClass(e) {
  const n = e.name
  if (n === 'item' || n === 'Item' || n === 'item_stack') return 'drop'
  if (BACKGROUND.has(n)) return 'background'
  if (THREATS.has(n)) return 'threat'
  const type = state.bot?.registry?.entitiesByName?.[n]?.type
  if (type === 'hostile') return 'threat'
  return 'tracked'
}

module.exports = { entityClass }
