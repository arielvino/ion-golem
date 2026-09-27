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
  assert.strictEqual(j.renderNotes(20, j.notes[0].ts + 7 * 60000), 'NOTES (1):\nn1 @s6 (7m ago) south floods [r1]')
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
  assert.deepStrictEqual(j.note('pivoting [pos, biome, n1, n8]').sources, ['pos', 'biome', 'n1'])
  assert.throws(() => j.note('made up [r99,VISION]'), /unknown record\(s\) r99/)
  assert.strictEqual(j.renderNotes().split('\n')[1], 'n1 (0s ago) trying north instead of west [r36,slice]')
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

test('a turn record carries what was said, set in motion, asked for, and why', () => {
  const { formatTurn, logWhy } = require('../src/world/journalStore')
  const why = logWhy('Digging. [LOG:pillar over a cavern, no wall to stair into; used=n52,pos; missing=none] [ACTION:mine:dirt]')
  assert.strictEqual(why, 'pillar over a cavern, no wall to stair into')
  assert.strictEqual(
    formatTurn({ said: 'Digging  down.', actions: ['mine:dirt:108,83,80', 'goto:108,75,80'], views: ['slice:ns'], why }),
    'me: "Digging down." → mine:dirt:108,83,80, goto:108,75,80 | asked slice:ns | why: pillar over a cavern, no wall to stair into')
  assert.strictEqual(formatTurn({ said: 'Still digging.' }), 'me: "Still digging."')
  assert.strictEqual(formatTurn({ actions: ['stop'] }), 'stop')
  assert.strictEqual(formatTurn({}), '')
})

test('compaction does not carry references to the notes it merges away', () => {
  const j = new Journal()
  j.record('x')
  j.note('a [r1,slice]'); j.note('b [n1,VISION]'); j.note('c [n2]')
  const { note } = j.compact('n1-n3', 'merged [inv]')
  assert.deepStrictEqual([note.cites, note.sources], [['r1'], ['slice', 'VISION', 'inv']])
  assert.deepStrictEqual(j.note('d [n4,n1,n2-n3]').sources, ['n4'])
})

test('a long basis is shortened in the view but kept in full', () => {
  const j = new Journal()
  for (let i = 0; i < 20; i++) j.record(`e${i}`)
  const ids = Array.from({ length: 20 }, (_, i) => `r${i + 1}`).join(',')
  const n = j.note(`long story [${ids},slice]`)
  assert.strictEqual(n.cites.length, 20)
  assert.match(j.renderNotes(), /\[r1,r2,r3,r4,r5,r6 \+15 more\]$/)
})

test('loading drops note references that no longer resolve', () => {
  const k = Journal.fromJSON({ records: [{ id: 'r1', ts: 0, text: 'x' }], rseq: 1, nseq: 9,
    notes: [{ id: 'n9', ts: 0, text: 'old', cites: ['r1'], sources: ['n3', 'n4-n7', 'slice', 'n9'] }] })
  assert.deepStrictEqual(k.notes[0].sources, ['slice', 'n9'])
})

test('a leading @node in a note is the attachment, not text', () => {
  const state = require('../src/core/state')
  const { applyNoteTags } = require('../src/world/journalStore')
  const saved = { journal: state.journal, agenda: state.agenda, dir: state.BOT_DATA_DIR }
  state.BOT_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'jnode-'))
  state.journal = new Journal()
  state.journal.record('x')
  const nodes = new Map([['g1', {}], ['s3', {}]])
  // Working on s3 (under g1).
  state.agenda = { tree: { nodes, activePath: () => [{ id: 'g1' }, { id: 's3' }] }, focus: () => ({ id: 'g1' }) }
  applyNoteTags('[NOTE:@g1 third attempt [r1]] [NOTE:@s3 @s3 probe again] [NOTE:plain] [NOTE:@g9 unknown node]')
  const [a, b, c, d] = state.journal.notes
  assert.deepStrictEqual([a.node, a.text], ['g1', 'third attempt'])
  assert.deepStrictEqual([b.node, b.text], ['s3', 'probe again'])
  assert.deepStrictEqual([c.node, c.text], ['s3', 'plain'])
  assert.deepStrictEqual([d.node, d.text], ['s3', 'unknown node'])
  assert.match(state.journal.renderNotes(), /^n1 @g1 \(0s ago\) third attempt \[r1\]$/m)
  Object.assign(state, { journal: saved.journal, agenda: saved.agenda, BOT_DATA_DIR: saved.dir })
})

test('ago reads like a person says it', () => {
  const { ago } = require('../src/world/journal')
  assert.deepStrictEqual([ago(40e3), ago(7 * 60e3), ago(125 * 60e3), ago(76 * 3600e3)], ['40s', '7m', '2h05m', '3d4h'])
})
