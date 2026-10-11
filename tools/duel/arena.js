// The duel arena: a walled stone-brick floor in the air, sealed with barriers so
// nothing gets in or out, with four cover walls around the centre. Built and reset
// through the server console FIFO; nothing here needs an op client.
const fs = require('fs')
const path = require('path')

const CONSOLE = process.env.MC_CONSOLE ||
  path.resolve(__dirname, '../../../server/server.stdin')
// The console's replies land in the server log.
const LOG = process.env.MC_LOG || path.join(path.dirname(CONSOLE), 'logs', 'latest.log')

// Floor at Y, play area X/Z in [-R, R], barrier shell one block outside it and
// one below the floor (BOTTOM): a bot digging through the floor meets barrier,
// not a 99-block drop.
const Y = 150
const BOTTOM = Y - 1
const R = 12
const TOP = Y + 12
// A pristine copy of the arena, buried at the same X/Z (its BOTTOM at COPY_Y): a
// run checks the arena against it and repairs it from it instead of rebuilding.
const COPY_Y = -50
const COPY_TOP = COPY_Y + TOP - BOTTOM
// Fighters take the corners in turn: NW, SE, NE, SW (a fifth starts 3 blocks in
// from the first, and so on).
const CORNERS = [[-10, -10], [10, 10], [10, -10], [-10, 10]]
// Where a spectator sees the whole floor.
const VIEW = { x: 0, y: Y + 9, z: -R }
// The dead respawn here, on the barrier roof: out of the fight, watching it.
const BENCH = { x: 0, y: TOP + 1, z: 0 }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// One command per write, spaced out: a burst written at once loses lines.
async function cmd(line) {
  fs.writeFileSync(CONSOLE, line + '\n')
  await sleep(150)
}

const box = `x=${-R - 1},y=${Y},z=${-R - 1},dx=${2 * R + 2},dy=${TOP - Y},dz=${2 * R + 2}`

// Sends a console command and returns its reply from the server log: the first new
// line matching `pattern`, or null after `ms`.
async function ask(line, pattern, ms = 3000) {
  const from = fs.statSync(LOG).size
  await cmd(line)
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) {
    const fd = fs.openSync(LOG, 'r')
    const buf = Buffer.alloc(fs.fstatSync(fd).size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)
    const m = buf.toString().match(pattern)
    if (m) return m[0]
  }
  return null
}

const a = -R - 1, b = R + 1
const matchesCopy = async () =>
  /passed/.test(await ask(`execute if blocks ${a} ${BOTTOM} ${a} ${b} ${TOP} ${b} ${a} ${COPY_Y} ${a} all`, /Test (passed|failed)/) || '')

// Whether the copy is there at all: its barrier roof and bottom and its stone-brick
// floor. Without it, restoring from the copy would clone raw underground (gravel and
// all) into the sky.
const isBlock = async (x, y, z, block) =>
  /passed/.test(await ask(`execute if block ${x} ${y} ${z} ${block}`, /Test (passed|failed)/) || '')
const copyExists = async () =>
  await isBlock(a, COPY_TOP, a, 'barrier') && await isBlock(a, COPY_Y, a, 'barrier') &&
  await isBlock(0, COPY_Y + Y - BOTTOM, 0, 'stone_bricks')

// The arena as built: left alone if it matches its copy, restored from the copy if
// it doesn't, and built from scratch (and copied) only when there's no copy yet.
async function ready() {
  await cmd(`forceload add ${a} ${a} ${b} ${b}`)
  if (await matchesCopy()) return 'intact'
  if (!await copyExists()) { await build(); await saveCopy(); return 'built' }
  await cmd(`clone ${a} ${COPY_Y} ${a} ${b} ${COPY_TOP} ${b} ${a} ${BOTTOM} ${a}`)
  if (await matchesCopy()) return 'repaired'
  await build()
  await saveCopy()
  return 'built'
}

const saveCopy = () => cmd(`clone ${a} ${BOTTOM} ${a} ${b} ${TOP} ${b} ${a} ${COPY_Y} ${a}`)

async function build() {
  await cmd(`fill ${a} ${BOTTOM} ${a} ${b} ${TOP} ${b} barrier hollow`)
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
  for (const [side, c] of Object.entries(COLORS)) {
    await cmd(`team add duel_${side}`)
    await cmd(`team modify duel_${side} color ${c.team}`)
    await cmd(`team modify duel_${side} friendlyFire false`)
  }
}

const ARMOR = [
  ['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'],
  ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']
]
// A side shows its colour in its armour trim (iron can't be dyed) and its name tag.
const COLORS = {
  red: { trim: 'redstone', team: 'red' },
  blue: { trim: 'lapis', team: 'blue' }
}

// The strategy's kit in iron armour, full health, at corner number `n`. Hunger
// and saturation are left to the game, so regeneration runs at its normal pace.
async function prepare(name, side, kit, n) {
  const [cx, cz] = CORNERS[n % CORNERS.length]
  const inward = Math.floor(n / CORNERS.length) * 3
  const s = { x: cx - Math.sign(cx) * inward, y: Y + 1, z: cz - Math.sign(cz) * inward }
  await cmd(`clear ${name}`)
  await cmd(`effect clear ${name}`)
  const trim = `[trim={material:"${COLORS[side].trim}",pattern:"sentry"}]`
  for (const [slot, item] of ARMOR) await cmd(`item replace entity ${name} ${slot} with ${item}${trim}`)
  for (const [slot, item] of kit.hands) await cmd(`item replace entity ${name} ${slot} with ${item}`)
  await cmd(`team join duel_${side} ${name}`)
  for (const [item, count] of kit.bag) await cmd(`give ${name} ${item} ${count}`)
  await cmd(`effect give ${name} instant_health 1 10 true`)
  await cmd(`spawnpoint ${name} ${BENCH.x} ${BENCH.y} ${BENCH.z}`)
  await cmd(`tp ${name} ${s.x + 0.5} ${s.y} ${s.z + 0.5} facing 0 ${s.y + 1} 0`)
}

// Drops, arrows and stray mobs from the last round.
async function sweep() {
  await cmd(`kill @e[type=!player,${box}]`)
}

module.exports = { ready, build, saveCopy, prepare, sweep, cmd, VIEW, BENCH, Y, R }
