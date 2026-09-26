// Unit tests for the past-data [CTX:...] views (src/ai/ctxPast.js), against a
// throwaway DB built with the real schema. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const state = require('../src/core/state')
const memory = require('../src/world/memory')
const { Journal } = require('../src/world/journal')
const { PROVIDERS, renderPending } = require('../src/ai/ctxProviders')

state.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpast-'))
memory.initDB()
state.bot = { entity: { position: { x: 10.5, y: 64, z: 10.5 } }, time: { age: 30000, day: 1 } }

memory.logGameEvent('mine', 'iron_ore', 1, 12, 40, 10, { tool: 'stone_pickaxe' })
memory.logGameEvent('mine', 'stone', 3, 200, 60, 200)
memory.logGameEvent('craft', 'stick', 4)
memory.logChatDB('chat', 'Sargon564', 'bring me iron')
memory.logChatDB('chat', 'Tester', 'hello')

const view = (name, ...args) => PROVIDERS[name].render(args)

test('events render one compact line each, detail as key=value', () => {
  const out = view('events', 'mine')
  assert.match(out, /^recent events \(mine\) \(oldest first\):/)
  assert.match(out, /day1 \d\d:\d\d mine iron_ore @12,40,10 tool=stone_pickaxe/)
  assert.match(out, /mine stone ×3 @200,60,200$/m)
  assert.doesNotMatch(out, /craft/)
})

test('near defaults to where the bot stands and honours radius and type', () => {
  const here = view('near')
  assert.match(here, /within 16m of 10,64,10/)
  assert.match(here, /none — nothing happened here/, 'iron_ore is 24 blocks down — outside 16m')
  assert.match(view('near', '30', 'mine'), /iron_ore/)
  assert.doesNotMatch(view('near', '30', 'mine'), /stone ×3/)
  assert.match(view('near', '200,60,200', '4'), /stone ×3/)
})

test('chat takes a player name or a limit; stats groups by type', () => {
  assert.match(view('chat', 'Sargon564'), /<Sargon564> bring me iron/)
  assert.doesNotMatch(view('chat', 'Sargon564'), /Tester/)
  assert.strictEqual(view('chat', '1').split('\n').length, 2)
  assert.match(view('stats'), /^mine: stone×3, iron_ore×1$/m)
  assert.match(view('chatsearch', 'iron'), /bring me iron/)
})

test('records come from the journal and say when one is gone', () => {
  state.journal = new Journal()
  state.journal.record('goto:1,2,3 failed')
  const out = view('records', 'r1,r5')
  assert.match(out, /^r1 .* goto:1,2,3 failed$/m)
  assert.match(out, /^r5 \(no longer kept/m)
})

test('bad arguments come back as CTX_ERR through the normal channel', () => {
  state.ctxRequests = [{ name: 'container', args: ['nope'] }, { name: 'structures', args: [] }]
  const out = renderPending()
  assert.match(out, /CTX_ERR: container failed: give coords/)
  assert.match(out, /structures \(newest first\):\nnone built yet/)
})
