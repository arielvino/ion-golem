// TALK=: the recent conversation stays in view with what each line got. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Talk, KEEP_MS } = require('../src/ai/talk')

test('a request stays in view with the reply and what it did, turns later', () => {
  const t = new Talk(), T = 1_000_000
  // The 2026-10-18 run: asked to clean the notes, five turns later asked if it had.
  t.heard('Sargon564', 'update every stale notes', T)
  t.answered({ said: 'Stale notes, my specialty.', notes: ['n16 {bed,home} ← n1', 'n18 ← n15'] })
  for (let i = 0; i < 4; i++) t.answered({ said: 'Still digging.' })   // later turns answer nothing old
  t.heard('Sargon564', 'did you do what i asked about the notes?', T + 39_000)
  assert.strictEqual(t.render(T + 39_000, T + 39_000),
    'TALK=[39s ago Sargon564: "update every stale notes" → me: "Stale notes, my specialty." notes: n16 {bed,home} ← n1; n18 ← n15]')
})

test('a line a cut-off turn never answered says so; old lines leave the view', () => {
  const t = new Talk(), T = 1_000_000
  t.heard('Sargon564', 'come', T)
  t.answered({ actions: ['come:Sargon564'] })
  t.heard('Sargon564', 'make tool', T + KEEP_MS)
  const now = T + KEEP_MS + 5000
  assert.strictEqual(t.render(now, now), 'TALK=[5s ago Sargon564: "make tool" → (no answer yet)]')
  assert.strictEqual(new Talk().render(now, now), '')
})
