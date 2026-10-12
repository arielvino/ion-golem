// damageCause.js — what hurt the bot, from the damage type the server names with each
// hit (mineflayer's entityHurt passes it, 1.19.4+).

// Types some entity deals: only these are worth looking around for an attacker.
const ATTACK_TYPES = new Set([
  'mob_attack', 'mob_attack_no_aggro', 'player_attack', 'arrow', 'trident', 'mob_projectile',
  'spit', 'fireball', 'unattributed_fireball', 'wither_skull', 'sting', 'thrown', 'sonic_boom',
  'explosion', 'player_explosion', 'indirect_magic', 'wind_charge', 'mace_smash', 'thorns'
])

const NAMES = {
  in_wall: 'suffocating inside a block',
  fall: 'a fall',
  lava: 'lava',
  in_fire: 'standing in fire',
  on_fire: 'burning',
  campfire: 'a campfire',
  hot_floor: 'a magma block',
  cactus: 'a cactus',
  sweet_berry_bush: 'a berry bush',
  drown: 'drowning',
  starve: 'starving',
  freeze: 'freezing in powder snow',
  falling_block: 'a falling block',
  falling_anvil: 'a falling anvil',
  falling_stalactite: 'a falling stalactite',
  stalagmite: 'a stalagmite',
  fly_into_wall: 'flying into a wall',
  out_of_world: 'the void',
  outside_border: 'the world border',
  wither: 'the wither effect',
  magic: 'poison or magic',
  cramming: 'cramming',
  lightning_bolt: 'lightning',
  bad_respawn_point: 'an exploding bed or respawn anchor',
  generic: 'something unnamed'
}

/** The cause in words: "a fall", "lava", … or "an unknown source" when the server named none. */
function damageCause(type) {
  if (!type) return 'an unknown source'
  return NAMES[type] || type.replace(/_/g, ' ')
}

/** Whether damage of this type can have an attacker; an unnamed type might. */
function hasAttacker(type) {
  return !type || ATTACK_TYPES.has(type)
}

module.exports = { damageCause, hasAttacker }
