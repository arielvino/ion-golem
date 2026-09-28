// Unit tests for no-unpermitted-breaking mode. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const state = require('../src/core/state')
const bp = require('../src/engine/breakPermission')

const said = []
function reset(mode = 'ask') {
  state.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'))
  state.bot = { username: 'Bro', chat: (m) => said.push(m) }
  state.breakMode = null   // force a fresh load
  state.backgroundTask = null
  bp.setMode(mode, 'test')
  said.length = 0
}
const running = (actionStr) => {
  const [action, ...rest] = actionStr.split(':')
  state.backgroundTask = { action, target: rest.join(':'), actionStr, status: 'running' }
}
const pos = { x: 1, y: 2, z: 3 }

test('mode off: breaking is always allowed, no BREAK= line', () => {
  reset('free')
  running('mine:stone:1,2,3')
  assert.equal(bp.mayBreak('stone', pos, 'mine_action'), true)
  assert.equal(bp.contextLine(), '')
})

test('mode on: nothing breaks without an approval, and the refusal is reported', () => {
  reset('ask')
  running('goto:10,60,10:staircase')
  assert.equal(bp.mayBreak('stone', pos, 'staircase'), false)
  assert.match(bp.contextLine(), /blocked: stone@1,2,3 during goto:10,60,10:staircase/)
})

test('a player yes approves exactly the requested action; other actions stay refused', () => {
  reset('ask')
  bp.requestBreak('goto:10,60,10:staircase')
  assert.match(bp.contextLine(), /pending: goto:10,60,10:staircase/)
  bp.onPlayerChat('Sargon564', 'yes')
  assert.match(bp.contextLine(), /approved: goto:10,60,10:staircase \(by Sargon564/)
  running('goto:10,60,10:staircase')
  assert.equal(bp.mayBreak('stone', pos), true)
  running('goto:99,60,99:staircase')
  assert.equal(bp.mayBreak('stone', pos), false, 'different coords need their own approval')
  running('mine:stone')
  assert.equal(bp.mayBreak('stone', pos), false)
})

test('the model cannot approve itself: without a pending request a yes grants nothing', () => {
  reset('ask')
  bp.onPlayerChat('Sargon564', 'yes')
  running('mine:stone')
  assert.equal(bp.mayBreak('stone', pos), false)
})

test('a no refuses the pending request', () => {
  reset('ask')
  bp.requestBreak('mine:oak_log:3')
  bp.onPlayerChat('benjco', 'no thanks')
  assert.match(bp.contextLine(), /refused: mine:oak_log:3 \(by benjco\)/)
  running('mine:oak_log:3')
  assert.equal(bp.mayBreak('oak_log', pos), false)
})

test('Hebrew yes/no work; unrelated chat is ignored', () => {
  assert.ok(bp.APPROVE_RE.test('כן'))
  assert.ok(bp.APPROVE_RE.test('מאשר'))
  assert.ok(bp.DENY_RE.test('לא'))
  assert.ok(!bp.APPROVE_RE.test('yesterday I saw a creeper'))
  assert.ok(!bp.APPROVE_RE.test('come here'))
  assert.ok(!bp.DENY_RE.test('nothing'))
})

test('!nobreak on/off switches the mode, persists it, and is not passed to the AI', () => {
  reset('free')
  assert.equal(bp.onPlayerChat('Sargon564', '!nobreak on'), true)
  assert.equal(state.breakMode, 'ask')
  const saved = JSON.parse(fs.readFileSync(path.join(state.BOT_DATA_DIR, 'break-mode.json'), 'utf8'))
  assert.equal(saved.mode, 'ask')
  state.breakMode = null   // simulate a restart: reload from disk
  running('mine:stone')
  assert.equal(bp.mayBreak('stone', pos), false)
  assert.equal(bp.onPlayerChat('Sargon564', '!nobreak off'), true)
  assert.equal(bp.mayBreak('stone', pos), true)
  assert.equal(bp.onPlayerChat('Sargon564', 'hello'), false)
})
