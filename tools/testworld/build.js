#!/usr/bin/env node
// Builds a reusable, sealed test world from a slice of an existing world.
//
// Copies 5x5 chunk columns x 5+ chunk sections (80x80x80+ blocks) out of a source world into a
// fresh void world. The slice starts two sections below the median surface's section and runs
// at least two above it, more if needed to leave HEADROOM air over the tallest block.
// The cube is then sealed with a one-block barrier shell just outside it, written straight
// into the chunk data (the ring of chunks around the 5x5 holds only the walls). Leaves are
// made persistent (their logs may lie outside the slice), and time, weather and mob spawning
// are frozen, so every run starts from the same state.
//
// Usage (from bot/):
//   node tools/testworld/build.js --name spawn [--src ../server/world] [--center X,Z]
//
// --center is a block position (default: the source world's spawn); its chunk becomes the
// middle of the 5x5. The result is written to <project>/test-worlds/<name>/ and is started with
// tools/testworld/testserver.sh. Stop or `save-all flush` the source server first, so the
// region files on disk are current.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const nbt = require('prismarine-nbt')
const { readChunk, writeChunks } = require('./anvil')

const PROJECT = path.resolve(__dirname, '../../..')
const SERVER = path.join(PROJECT, 'server') // jar + libraries are borrowed from here
const TESTSERVER = path.join(PROJECT, 'testserver')
const TEMPLATES = path.join(PROJECT, 'test-worlds')
const OVERWORLD = 'dimensions/minecraft/overworld'
const MIN_Y = -64
const SIZE = 5 // chunks per side
const SEED = 20261018 // fixed so the bot's world key is the same on every run
const HEADROOM = 16 // at least this much air between the tallest block (trees too) and the ceiling

function parseArgs () {
  const a = { src: path.join(SERVER, 'world'), name: null, center: null }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') a.src = path.resolve(argv[++i])
    else if (argv[i] === '--name') a.name = argv[++i]
    else if (argv[i] === '--center') a.center = argv[++i].split(',').map(Number)
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!a.name || !/^[\w-]+$/.test(a.name)) throw new Error('--name <word> is required')
  return a
}

async function readNbtFile (file) {
  return nbt.simplify((await nbt.parse(fs.readFileSync(file))).parsed)
}

// Decodes a 26.x heightmap (9-bit entries, 7 per long, no spanning) into absolute Y of the
// first block above the surface, indexed [z * 16 + x].
function heightmap (chunk, type) {
  const longs = chunk.value.Heightmaps.value[type].value
  const out = []
  for (const [hi, lo] of longs) {
    let v = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)
    for (let k = 0; k < 7 && out.length < 256; k++) {
      out.push(Number(v & 0x1ffn) + MIN_Y)
      v >>= 9n
    }
  }
  return out
}

const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1]

// Trims a source chunk to sections [syLo, syHi]: other sections become air (biomes kept).
function trimChunk (tree, syLo, syHi) {
  const v = tree.value
  const yLo = syLo * 16
  const yHi = syHi * 16 + 15
  const inY = y => y >= yLo && y <= yHi
  for (const sec of v.sections.value.value) {
    const sy = sec.Y.value
    delete sec.BlockLight
    delete sec.SkyLight
    const states = sec.block_states.value
    if (sy < syLo || sy > syHi) {
      states.palette = { type: 'list', value: { type: 'string', value: ['minecraft:air'] } }
      delete states.data
      continue
    }
    // 26.x palettes: a list of ids, or (when any entry has properties) of { id, properties }.
    const palette = states.palette.value
    if (palette.type !== 'compound') continue
    for (const entry of palette.value) {
      if (entry.id && entry.id.value.endsWith('_leaves') && entry.properties) {
        entry.properties.value.persistent = { type: 'string', value: 'true' }
      }
    }
  }
  const bottomSection = v.yPos.value
  v.PostProcessing.value.value = v.PostProcessing.value.value.map((list, i) =>
    (bottomSection + i < syLo || bottomSection + i > syHi) ? { ...list, value: [] } : list)
  for (const key of ['block_entities', 'block_ticks', 'fluid_ticks']) {
    const list = v[key].value
    list.value = (list.value || []).filter(e => inY(e.y.value))
  }
  v.structures.value = {
    References: { type: 'compound', value: {} },
    starts: { type: 'compound', value: {} }
  }
  delete v.Heightmaps // primed again by the server on load
  v.isLightOn = { type: 'byte', value: 0 } // forces a relight
  return tree
}

function trimEntities (tree, yLo, yHi) {
  const list = tree.value.Entities.value
  list.value = (list.value || []).filter(e => {
    const y = e.Pos.value.value[1]
    return y >= yLo && y < yHi + 1
  })
  return tree
}

// Encodes 4096 palette indices (index (y * 16 + z) * 16 + x) as a 26.x block_states compound
// with a string palette: 4+ bits per entry, entries never span two longs.
function encodeStates (palette, idx) {
  const states = { palette: { type: 'list', value: { type: 'string', value: palette } } }
  if (palette.length === 1) return states
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)))
  const per = Math.floor(64 / bits)
  const longs = []
  for (let i = 0; i < idx.length; i += per) {
    let v = 0n
    for (let k = Math.min(per, idx.length - i) - 1; k >= 0; k--) v = (v << BigInt(bits)) | BigInt(idx[i + k])
    longs.push([Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v & 0xffffffffn))])
  }
  states.data = { type: 'longArray', value: longs }
  return states
}

// An empty (all-air) chunk at cx, cz, shaped like a trimmed source chunk so the server takes
// it as fully generated.
function emptyChunk (like, cx, cz) {
  const tree = structuredClone(like)
  const v = tree.value
  v.xPos.value = cx
  v.zPos.value = cz
  for (const sec of v.sections.value.value) {
    sec.block_states.value = encodeStates(['minecraft:air'])
  }
  for (const key of ['block_entities', 'block_ticks', 'fluid_ticks']) v[key].value.value = []
  v.PostProcessing.value.value = v.PostProcessing.value.value.map(list => ({ ...list, value: [] }))
  return tree
}

// Writes the barrier shell one block outside the cube into the chunk data: the floor and
// ceiling layers over the 5x5 (sections the trim left as air), and the walls in a ring of
// otherwise empty chunks around it. Returns the 5x5 plus that ring.
function sealCube (chunks, { X0, X1, Z0, Z1, yLo, yHi, syLo, syHi }) {
  const inShell = (x, y, z) => x >= X0 - 1 && x <= X1 + 1 && z >= Z0 - 1 && z <= Z1 + 1 && y >= yLo - 1 && y <= yHi + 1 &&
    !(x >= X0 && x <= X1 && z >= Z0 && z <= Z1 && y >= yLo && y <= yHi)
  const byPos = new Map(chunks.map(c => [`${c.cx},${c.cz}`, c]))
  const out = []
  for (let cx = (X0 >> 4) - 1; cx <= (X1 >> 4) + 1; cx++) {
    for (let cz = (Z0 >> 4) - 1; cz <= (Z1 >> 4) + 1; cz++) {
      const c = byPos.get(`${cx},${cz}`) || { cx, cz, tree: emptyChunk(chunks[0].tree, cx, cz) }
      const inside = byPos.has(`${cx},${cz}`)
      for (const sec of c.tree.value.sections.value.value) {
        const sy = sec.Y.value
        if (sy < syLo - 1 || sy > syHi + 1 || (inside && sy >= syLo && sy <= syHi)) continue
        const idx = new Array(4096).fill(0)
        let any = false
        for (let i = 0; i < 4096; i++) {
          const x = cx * 16 + (i & 15)
          const z = cz * 16 + ((i >> 4) & 15)
          const y = sy * 16 + (i >> 8)
          if (inShell(x, y, z)) { idx[i] = 1; any = true }
        }
        if (any) sec.block_states.value = encodeStates(['minecraft:air', 'minecraft:barrier'], idx)
      }
      out.push(c)
    }
  }
  return out
}

// Runs the test server in TESTSERVER until it stops; `script` gets send(cmd) -> output lines.
function runServer (script) {
  return new Promise((resolve, reject) => {
    const java = spawn('java', ['-Xms512M', '-Xmx1G', '-jar', 'server.jar', 'nogui'],
      { cwd: TESTSERVER, stdio: ['pipe', 'pipe', 'inherit'] })
    let buf = ''
    let waiter = null
    const lines = []
    java.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        lines.push(line)
        if (waiter) waiter()
      }
    })
    const waitFor = (re, start = lines.length, ms = 120000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${re}`)), ms)
      const check = () => {
        const hit = lines.slice(start).find(l => re.test(l))
        if (hit) { clearTimeout(t); waiter = null; resolve(hit) }
      }
      waiter = check
      check()
    })
    // Sends a console command; resolves with its output once `until` matches (or after 150 ms).
    const send = async (cmd, until) => {
      const start = lines.length
      java.stdin.write(cmd + '\n')
      if (until) await waitFor(until, start)
      else await new Promise(resolve => setTimeout(resolve, 150))
      return lines.slice(start)
    }
    java.on('exit', code => code === 0 ? resolve() : reject(new Error(`server exited ${code}`)))
    waitFor(/\[Server thread\/INFO\].*Done \(/)
      .then(() => script(send, waitFor))
      .then(() => { java.stdin.write('stop\n') })
      .catch(err => { java.kill(); reject(err) })
  })
}

// The 26.x spawn finder puts a joining player on top of the column, i.e. on the barrier
// ceiling. A tick function drops survival/adventure players found up there to the spawn point.
function writeDatapack (world, [x, y, z], ceilingY) {
  const dir = path.join(world, 'datapacks', 'testworld')
  fs.mkdirSync(path.join(dir, 'data/testworld/function'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'data/minecraft/tags/function'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pack.mcmeta'), JSON.stringify({
    pack: { description: 'IonGolem test world: keep players inside the cube', min_format: 121, max_format: 121 }
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'data/minecraft/tags/function/tick.json'), JSON.stringify({ values: ['testworld:tick'] }) + '\n')
  fs.writeFileSync(path.join(dir, 'data/testworld/function/tick.mcfunction'),
    `execute as @a[gamemode=!spectator,gamemode=!creative] at @s if entity @s[y=${ceilingY},dy=1000] run tp @s ${x} ${y} ${z}\n`)
}

function prepareServerDir () {
  fs.mkdirSync(TESTSERVER, { recursive: true })
  for (const f of ['server.jar', 'libraries', 'versions']) {
    const link = path.join(TESTSERVER, f)
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(SERVER, f), link)
  }
  fs.writeFileSync(path.join(TESTSERVER, 'eula.txt'), 'eula=true\n')
  const flat = JSON.stringify({
    layers: [{ block: 'minecraft:air', height: 1 }],
    biome: 'minecraft:plains',
    features: false,
    lakes: false,
    structure_overrides: []
  })
  fs.writeFileSync(path.join(TESTSERVER, 'server.properties'), [
    'server-port=25566',
    'online-mode=false',
    'white-list=false',
    'enforce-whitelist=false',
    'enable-rcon=false',
    'enable-query=false',
    'management-server-port=0',
    'motd=IonGolem test world',
    'level-name=world',
    `level-seed=${SEED}`,
    'level-type=minecraft\\:flat',
    `generator-settings=${flat.replace(/:/g, '\\:')}`,
    'generate-structures=false',
    'spawn-protection=0',
    'view-distance=6',
    'simulation-distance=6',
    'difficulty=easy',
    'gamemode=survival',
    'allow-flight=true',
    ''
  ].join('\n'))
}

async function main () {
  const args = parseArgs()
  const level = await readNbtFile(path.join(args.src, 'level.dat'))
  const [sx, , sz] = args.center ? [args.center[0], 0, args.center[1]] : level.Data.spawn.pos
  const cx0 = (sx >> 4) - 2
  const cz0 = (sz >> 4) - 2
  const X0 = cx0 * 16
  const Z0 = cz0 * 16
  const X1 = X0 + SIZE * 16 - 1
  const Z1 = Z0 + SIZE * 16 - 1

  // Read the 5x5 columns and pick the vertical slice around the median surface.
  const cols = []
  for (let dx = 0; dx < SIZE; dx++) {
    for (let dz = 0; dz < SIZE; dz++) {
      const cx = cx0 + dx
      const cz = cz0 + dz
      const tree = await readChunk(path.join(args.src, OVERWORLD, 'region'), cx, cz)
      if (!tree) throw new Error(`chunk ${cx},${cz} is not generated in ${args.src}`)
      if (tree.value.Status.value !== 'minecraft:full') throw new Error(`chunk ${cx},${cz} is not fully generated`)
      const entities = await readChunk(path.join(args.src, OVERWORLD, 'entities'), cx, cz)
      cols.push({ cx, cz, tree, entities, surface: heightmap(tree, 'MOTION_BLOCKING_NO_LEAVES'), top: heightmap(tree, 'MOTION_BLOCKING') })
    }
  }
  const surfaceY = median(cols.flatMap(c => c.surface)) - 1 // top surface block
  const syMid = Math.floor(surfaceY / 16)
  const syLo = syMid - 2
  // Sections are added on top until the tallest column clears the ceiling by HEADROOM.
  const topY = Math.max(...cols.flatMap(c => c.top)) - 1
  const syHi = Math.max(syMid + 2, Math.ceil((topY + HEADROOM + 1) / 16) - 1)
  const yLo = syLo * 16
  const yHi = syHi * 16 + 15
  console.log(`[testworld] cube x ${X0}..${X1}, z ${Z0}..${Z1}, y ${yLo}..${yHi} (median surface y=${surfaceY}, tallest block y=${topY})`)

  const column = (x, z, field) => {
    const c = cols.find(c => c.cx === x >> 4 && c.cz === z >> 4)
    return c[field][(z & 15) * 16 + (x & 15)]
  }

  const midX = X0 + 40
  const midZ = Z0 + 40
  const spawnY = Math.min(column(midX, midZ, 'surface'), yHi)
  const cmds = [
    `setworldspawn ${midX} ${spawnY} ${midZ}`,
    'gamerule minecraft:advance_time false',
    'gamerule minecraft:advance_weather false',
    'gamerule minecraft:spawn_mobs false',
    'gamerule minecraft:spawn_monsters false',
    'gamerule minecraft:spawn_phantoms false',
    'gamerule minecraft:spawn_patrols false',
    'gamerule minecraft:spawn_wandering_traders false',
    'gamerule minecraft:spawn_wardens false',
    'gamerule minecraft:respawn_radius 0',
    'time set 6000',
    'weather clear'
  ]

  // 1. Fresh void world, so level.dat and the data files come from the server itself.
  prepareServerDir()
  const world = path.join(TESTSERVER, 'world')
  fs.rmSync(world, { recursive: true, force: true })
  console.log('[testworld] generating void world')
  await runServer(async () => {})

  // 2. Drop in the trimmed chunks; everything else regenerates as void.
  for (const d of ['region', 'entities', 'poi']) fs.rmSync(path.join(world, OVERWORLD, d), { recursive: true, force: true })
  const trimmed = cols.map(c => ({ cx: c.cx, cz: c.cz, tree: trimChunk(c.tree, syLo, syHi) }))
  const chunks = sealCube(trimmed, { X0, X1, Z0, Z1, yLo, yHi, syLo, syHi })
  writeChunks(path.join(world, OVERWORLD, 'region'), chunks)
  writeChunks(path.join(world, OVERWORLD, 'entities'), cols.filter(c => c.entities).map(c => ({ cx: c.cx, cz: c.cz, tree: trimEntities(c.entities, yLo, yHi) })))
  writeDatapack(world, [midX + 0.5, spawnY, midZ + 0.5], yHi + 1)

  // 3. Freeze the world state.
  console.log(`[testworld] setting world state (${cmds.length} commands)`)
  const errors = []
  await runServer(async send => {
    for (const cmd of cmds) {
      const out = await send(cmd)
      const bad = out.filter(l => /\[Server thread\//.test(l) && /Could not|not loaded|Unknown|Incorrect|Invalid|Too many|No blocks/i.test(l))
      if (bad.length) errors.push(`${cmd}\n    ${bad.join('\n    ')}`)
    }
    const packs = await send('datapack list enabled', /data pack\(s\) enabled/)
    if (!packs.some(l => l.includes('file/testworld'))) errors.push(`datapack not enabled:\n    ${packs.join('\n    ')}`)
    await send('save-all flush', /Saved the game/)
  })
  if (errors.length) throw new Error(`commands failed:\n  ${errors.join('\n  ')}`)

  // 4. Store the template.
  const out = path.join(TEMPLATES, args.name)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(TEMPLATES, { recursive: true })
  fs.cpSync(world, out, { recursive: true, filter: src => !src.endsWith('session.lock') })
  const meta = {
    name: args.name,
    source: args.src,
    sourceSpawn: level.Data.spawn.pos,
    seed: SEED,
    cube: { min: [X0, yLo, Z0], max: [X1, yHi, Z1] },
    chunks: { min: [cx0, cz0], max: [cx0 + SIZE - 1, cz0 + SIZE - 1] },
    surfaceY,
    spawn: [midX, spawnY, midZ],
    built: new Date().toISOString()
  }
  fs.writeFileSync(path.join(out, 'testworld.json'), JSON.stringify(meta, null, 2) + '\n')
  console.log(`[testworld] wrote ${out}`)
  console.log(JSON.stringify(meta))
}

main().catch(err => { console.error(err); process.exit(1) })
