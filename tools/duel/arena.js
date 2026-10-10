// The duel arena: a walled stone-brick floor in the air, sealed with barriers so
// nothing gets in or out, with four cover walls around the centre. Built and reset
// through the server console FIFO; nothing here needs an op client.
const fs = require('fs')
const path = require('path')

const CONSOLE = process.env.MC_CONSOLE ||
  path.resolve(__dirname, '../../../server/server.stdin')

// Floor at Y, play area X/Z in [-R, R], barrier shell one block outside it.
const Y = 150
const R = 12
const TOP = Y + 12
const SPAWNS = {
  hunter: { x: -10, y: Y + 1, z: -10 },
  defender: { x: 10, y: Y + 1, z: 10 }
}
// Where a spectator sees the whole floor.
const VIEW = { x: 0, y: Y + 9, z: -R }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// One command per write, spaced out: a burst written at once loses lines.
async function cmd(line) {
  fs.writeFileSync(CONSOLE, line + '\n')
  await sleep(150)
}

const box = `x=${-R - 1},y=${Y},z=${-R - 1},dx=${2 * R + 2},dy=${TOP - Y},dz=${2 * R + 2}`

async function build() {
  const a = -R - 1, b = R + 1
  await cmd(`forceload add ${a} ${a} ${b} ${b}`)
  await cmd(`fill ${a} ${Y} ${a} ${b} ${TOP} ${b} barrier hollow`)
  await cmd(`fill ${a} ${Y} ${a} ${b} ${Y} ${b} stone_bricks`)
  // The four walls one at a time: a `hollow` box would also roof the floor over.
  await cmd(`fill ${a} ${Y + 1} ${a} ${b} ${Y + 3} ${a} stone_bricks`)
  await cmd(`fill ${a} ${Y + 1} ${b} ${b} ${Y + 3} ${b} stone_bricks`)
  await cmd(`fill ${a} ${Y + 1} ${a} ${a} ${Y + 3} ${b} stone_bricks`)
  await cmd(`fill ${b} ${Y + 1} ${a} ${b} ${Y + 3} ${b} stone_bricks`)
  // Lit from the floor and, invisibly, from under the ceiling.
  for (const x of [-9, -3, 3, 9]) for (const z of [-9, -3, 3, 9]) {
    await cmd(`setblock ${x} ${Y} ${z} glowstone`)
    await cmd(`setblock ${x} ${TOP - 1} ${z} light[level=15]`)
  }
  // Cover: four 3-wide, 3-high walls in a broken ring around the centre.
  await cmd(`fill -6 ${Y + 1} -1 -6 ${Y + 3} 1 cobblestone`)
  await cmd(`fill 6 ${Y + 1} -1 6 ${Y + 3} 1 cobblestone`)
  await cmd(`fill -1 ${Y + 1} -6 1 ${Y + 3} -6 cobblestone`)
  await cmd(`fill -1 ${Y + 1} 6 1 ${Y + 3} 6 cobblestone`)
  await cmd(`kill @e[type=!player,${box}]`)
}

const KIT = [
  ['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'],
  ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots'],
  ['weapon.mainhand', 'iron_sword'], ['weapon.offhand', 'shield']
]
const BAG = [['iron_axe', 1], ['bow', 1], ['arrow', 32], ['cooked_beef', 8]]

// Fresh kit, full health and hunger, at the role's corner.
async function prepare(name, role) {
  const s = SPAWNS[role]
  await cmd(`clear ${name}`)
  await cmd(`effect clear ${name}`)
  for (const [slot, item] of KIT) await cmd(`item replace entity ${name} ${slot} with ${item}`)
  for (const [item, n] of BAG) await cmd(`give ${name} ${item} ${n}`)
  await cmd(`effect give ${name} instant_health 1 10 true`)
  await cmd(`effect give ${name} saturation 1 20 true`)
  await cmd(`spawnpoint ${name} ${s.x} ${s.y} ${s.z}`)
  await cmd(`tp ${name} ${s.x + 0.5} ${s.y} ${s.z + 0.5} facing 0 ${s.y + 1} 0`)
}

// Drops, arrows and stray mobs from the last round.
async function sweep() {
  await cmd(`kill @e[type=!player,${box}]`)
}

module.exports = { build, prepare, sweep, cmd, SPAWNS, VIEW, Y, R }
