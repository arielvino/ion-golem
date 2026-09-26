// Unit tests for the journal (src/world/journal.js). Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { Journal, MAX_RECORDS } = require('../src/world/journal')

test('records are numbered and shown once', () => {
  const j = new Journal()
  j.record('mine:stone done'); j.record('staircase:south failed')
  assert.strictEqual(j.renderNew(), 'r1 mine:stone done | r2 staircase:south failed')
  j.markShown(2)
  assert.strictEqual(j.renderNew(), '')
  j.record('Sargon564: "stop"')
  assert.strictEqual(j.renderNew(), 'r3 Sargon564: "stop"')
})

test('consecutive identical records collapse; overflow is summarized', () => {
  const j = new Journal()
  j.record('a'); j.record('x'); j.record('x'); j.record('x'); j.record('b')
  assert.strictEqual(j.renderNew(), 'r1 a | r2-r4 ×3 x | r5 b')
  const k = new Journal()
  for (let i = 0; i < 30; i++) k.record(`e${i}`)
  assert.match(k.renderNew(), /^\(\+5 older\) r6 e5 \| /)
})

test('a note keeps its citations and node; unknown citations are rejected', () => {
  const j = new Journal()
  j.record('staircase:south failed'); j.record('staircase:south failed')
  const n = j.note('south side floods at y52 [r1, r2]', 's6')
  assert.deepStrictEqual([n.text, n.cites, n.node], ['south side floods at y52', ['r1', 'r2'], 's6'])
  assert.throws(() => j.note('made up [r9]'), /unknown record\(s\) r9/)
  assert.strictEqual(j.note('the player seems impatient').cites.length, 0)
})

test('compaction replaces a run in place and inherits every citation', () => {
  const j = new Journal()
  for (let i = 0; i < 4; i++) j.record(`e${i}`)
  j.note('first [r1]'); j.note('second [r2]'); j.note('third [r3]'); j.note('fourth')
  const { note, replaced } = j.compact('n2-n3', 'second and third, merged [r4]')
  assert.deepStrictEqual(replaced, ['n2', 'n3'])
  assert.deepStrictEqual(note.cites, ['r2', 'r3', 'r4'])
  assert.deepStrictEqual(j.notes.map(n => n.id), ['n1', 'n5', 'n4'])
  assert.throws(() => j.compact('n40-n41', 'x'), /no notes/)
  assert.throws(() => j.compact('3-9', 'x'), /bad range/)
})

test('renderNotes shows ids, nodes, citations and a size hint', () => {
  const j = new Journal()
  j.record('x')
  j.note('south floods [r1]', 's6')
  assert.strictEqual(j.renderNotes(), 'NOTES (1):\nn1 @s6 south floods [r1]')
  assert.match(j.renderNotes(1), /← long: consider \[NOTE:compact/)
  assert.strictEqual(new Journal().renderNotes(), '')
})

test('eviction drops old shown records but never cited or unseen ones', () => {
  const j = new Journal()
  j.record('keep me')
  j.note('important [r1]')
  for (let i = 0; i < MAX_RECORDS + 10; i++) j.record(`e${i}`)
  assert.ok(j.records.length > MAX_RECORDS) // nothing shown yet → nothing evictable
  j.markShown(j.rseq)
  j.record('one more')
  assert.strictEqual(j.records.length, MAX_RECORDS)
  assert.strictEqual(j.records[0].id, 'r1')
})

test('JSON round-trip keeps numbering and the shown cursor', () => {
  const j = new Journal()
  j.record('a'); j.markShown(1); j.record('b'); j.note('n [r1]')
  const k = Journal.fromJSON(JSON.parse(JSON.stringify(j)))
  assert.strictEqual(k.renderNew(), 'r2 b')
  assert.strictEqual(k.record('c').id, 'r3')
  assert.strictEqual(k.note('m').id, 'n2')
})

test('a mixed basis keeps its record ids as citations and the rest as sources', () => {
  const j = new Journal()
  for (let i = 0; i < 36; i++) j.record(`e${i}`)
  // Real note n20 from the 2026-09-26 run: r36 was silently dropped.
  const n = j.note('trying north instead of west [r36,slice]')
  assert.deepStrictEqual([n.text, n.cites, n.sources], ['trying north instead of west', ['r36'], ['slice']])
  assert.deepStrictEqual(j.note('pivoting [pos, biome, n8]').sources, ['pos', 'biome', 'n8'])
  assert.throws(() => j.note('made up [r99,VISION]'), /unknown record\(s\) r99/)
  assert.strictEqual(j.renderNotes().split('\n')[1], 'n1 trying north instead of west [r36,slice]')
})

test('compaction inherits sources as well as citations', () => {
  const j = new Journal()
  j.record('x')
  j.note('a [r1,slice]'); j.note('b [VISION]')
  const { note } = j.compact('n1-n2', 'a and b [inv]')
  assert.deepStrictEqual([note.cites, note.sources], [['r1'], ['slice', 'VISION', 'inv']])
})

test('lookup resolves ids and ranges, and says which records are gone', () => {
  const j = new Journal()
  for (let i = 1; i <= 5; i++) j.record(`e${i}`, 1790444000000 + i * 1000)
  j.records = j.records.filter(r => r.id !== 'r3')  // as if evicted
  assert.deepStrictEqual(j.lookup('r2-r4, r5 ,r2').map(x => [x.id, x.text ?? null]),
    [['r2', 'e2'], ['r3', null], ['r4', 'e4'], ['r5', 'e5']])
  assert.throws(() => j.lookup('n4'), /bad record id/)
  assert.throws(() => j.lookup('r1-r500'), /at most/)
})
