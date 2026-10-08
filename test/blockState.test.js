// Block memory keeps each block's state id (src/world/memory.js), read back as properties by
// dbProps (src/navigation/atomicSteps.js). A throwaway DB, the 26.1 registry.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const state = require('../src/core/state')
const memory = require('../src/world/memory')
const { dbProps, dbBlock } = require('../src/navigation/atomicSteps')

state.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blockstate-'))
memory.initDB()
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
state.bot = { registry }
memory.checkStateVersion('26.1')

const frame = (eye) => Block.fromProperties('end_portal_frame', { eye, facing: 'north' }, 0).stateId

test('a stored state reads back as the block\'s properties', () => {
  state.stmts.upsertBlock.run(0, 100, 0, 'end_portal_frame', 0, frame(true))
  state.stmts.upsertBlock.run(1, 100, 0, 'end_portal_frame', 0, frame(false))
  assert.strictEqual(dbBlock(0, 100, 0), 'end_portal_frame')
  assert.deepStrictEqual(dbProps(0, 100, 0), { eye: true, facing: 'north' })
  assert.deepStrictEqual(dbProps(1, 100, 0), { eye: false, facing: 'north' })
})

test('the vision batch path stores the state too', () => {
  state.stmts.upsertBatchReach([{ x: 2, y: 100, z: 0, name: 'end_portal_frame', state: frame(true), reachable: 'yes' }])
  assert.strictEqual(dbProps(2, 100, 0).eye, true)
})

test('a write without a state makes it unknown, not stale', () => {
  state.stmts.upsertBlock.run(0, 100, 0, 'end_portal_frame', 1, null)
  assert.strictEqual(dbProps(0, 100, 0), null)
  assert.strictEqual(dbProps(5, 100, 5), null)   // never seen
})

test('joining under another game version forgets the stored states, keeps the names', () => {
  state.stmts.upsertBlock.run(3, 100, 0, 'end_portal_frame', 0, frame(true))
  memory.checkStateVersion('26.3')
  assert.strictEqual(dbProps(3, 100, 0), null)
  assert.strictEqual(dbBlock(3, 100, 0), 'end_portal_frame')
  const n = state.db.prepare('SELECT COUNT(*) AS c FROM blocks WHERE state IS NOT NULL').get().c
  assert.strictEqual(n, 0)
})

test('the same version again keeps them', () => {
  state.stmts.upsertBlock.run(4, 100, 0, 'end_portal_frame', 0, frame(true))
  memory.checkStateVersion('26.3')
  assert.strictEqual(dbProps(4, 100, 0).eye, true)
})
