// Per-world data dirs: the world key, and leaving the old per-bot layout alone.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { seedHex, worldKey, openWorldDir, worldDirOf, oldLayoutFiles } = require('../src/core/dataDir')

const tmpBot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'datadir-'))
const quiet = (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return fn() } finally { console.log = l; console.warn = w } }

test('seedHex: protodef i64 [hi, lo], BigInt and a missing seed', () => {
  assert.strictEqual(seedHex([0x1a2b3c4d, 0x5e6f7a8b]), '1a2b3c4d5e6f7a8b')
  assert.strictEqual(seedHex([-1, -1]), 'ffffffffffffffff')
  assert.strictEqual(seedHex(-2n), 'fffffffffffffffe')
  assert.strictEqual(seedHex(0n), '0000000000000000')
  assert.strictEqual(seedHex(undefined), null)
})

test('worldKey: host + seed, readable and filesystem-safe', () => {
  const seed = [0x1a2b3c4d, 0x5e6f7a8b]
  assert.strictEqual(worldKey({ host: 'localhost', port: 25565, hashedSeed: seed }), 'localhost_1a2b3c4d5e6f7a8b')
  assert.strictEqual(worldKey({ host: '127.0.0.1', port: 25565, hashedSeed: seed }), 'localhost_1a2b3c4d5e6f7a8b')
  assert.strictEqual(worldKey({ host: '::1', port: 25565, hashedSeed: seed }), 'localhost_1a2b3c4d5e6f7a8b')
  assert.strictEqual(worldKey({ host: 'Biny.Aternos.me', port: 61234, hashedSeed: seed }), 'biny.aternos.me_1a2b3c4d5e6f7a8b')
  assert.strictEqual(worldKey({ host: '../x/y', port: 1, hashedSeed: undefined }), 'x-y_noseed')
  // Another port on the same host, same seed (an open-to-LAN world reopened) — the same world.
  assert.strictEqual(worldKey({ host: 'localhost', port: 40123, hashedSeed: seed }), worldKey({ host: 'localhost', port: 25565, hashedSeed: seed }))
  // Same host, another seed — another world.
  assert.notStrictEqual(worldKey({ host: 'localhost', port: 25565, hashedSeed: [0, 1] }), worldKey({ host: 'localhost', port: 25565, hashedSeed: seed }))
  // Another host, same seed — another world.
  assert.notStrictEqual(worldKey({ host: 'example.net', port: 25565, hashedSeed: seed }), worldKey({ host: 'localhost', port: 25565, hashedSeed: seed }))
})

test('openWorldDir: a fresh bot gets a new world dir with world.json', () => {
  const bot = tmpBot()
  const { key, dir } = quiet(() => openWorldDir(bot, { host: 'localhost', port: 25565, hashedSeed: [0, 7], version: '26.3' }))
  assert.strictEqual(key, 'localhost_0000000000000007')
  assert.strictEqual(dir, worldDirOf(bot, key))
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'))
  assert.strictEqual(meta.hashedSeed, '0000000000000007')
  assert.strictEqual(meta.port, 25565)
})

test('openWorldDir: old per-bot files are reported but never moved or used', () => {
  const bot = tmpBot()
  fs.writeFileSync(path.join(bot, 'blocks.db'), 'OLD')
  fs.writeFileSync(path.join(bot, 'journal.json'), '{"j":1}')
  assert.deepStrictEqual(oldLayoutFiles(bot), ['blocks.db', 'journal.json'])
  const a = quiet(() => openWorldDir(bot, { host: 'localhost', port: 25565, hashedSeed: [0, 1] }))
  assert.deepStrictEqual(fs.readdirSync(a.dir), ['world.json'])
  assert.strictEqual(fs.readFileSync(path.join(bot, 'blocks.db'), 'utf8'), 'OLD')
  assert.strictEqual(fs.readFileSync(path.join(bot, 'journal.json'), 'utf8'), '{"j":1}')
  assert.deepStrictEqual(oldLayoutFiles(tmpBot()), [])
})

test('openWorldDir: re-entering a world reuses its dir and keeps firstSeen', () => {
  const bot = tmpBot()
  const where = { host: 'localhost', port: 25565, hashedSeed: [0, 3] }
  const a = quiet(() => openWorldDir(bot, where))
  fs.writeFileSync(path.join(a.dir, 'journal.json'), 'kept')
  const first = JSON.parse(fs.readFileSync(path.join(a.dir, 'world.json'), 'utf8')).firstSeen
  const b = quiet(() => openWorldDir(bot, where))
  assert.strictEqual(b.dir, a.dir)
  assert.strictEqual(fs.readFileSync(path.join(b.dir, 'journal.json'), 'utf8'), 'kept')
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(b.dir, 'world.json'), 'utf8')).firstSeen, first)
})
