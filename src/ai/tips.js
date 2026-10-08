// tips.js — game knowledge shown to the model while the situation it is about lasts.
//
// The system prompt is sent every turn, so knowledge that only matters in a rare
// situation (a spawner in a stronghold) is either missing from it or paid for on
// every turn. A tip pairs a detector with a text in tips/<id>.txt, and rides along in
// the turn's input on every turn its detector holds. Every turn is a fresh session, so a
// tip shown once is forgotten by the next turn. Detectors read only what the bot knows:
// the block memory and the LOS survey, never bot.blockAt.
const fs = require('fs')
const path = require('path')
const state = require('../core/state')
const { queryBlockMemory } = require('../world/memory')

const TIP_DIR = path.join(__dirname, 'tips')

// A spawner runs while a player is within this many blocks of it.
const SPAWNER_RANGE = 16

// Every subject of a tip that applies now, as { key, vars }. key names the subject;
// vars fill the {NAME} slots of the text.
const TIPS = [
  {
    id: 'spawner',
    // Spawners the bot has seen, within their activation range. Remembered rather than
    // in sight, because one keeps spawning while hidden behind the portal frames.
    detect() {
      return queryBlockMemory(['spawner'], state.bot.entity.position)
        .filter(s => s.dist <= SPAWNER_RANGE)
        .map(({ x, y, z }) => ({ key: `${x},${y},${z}`, vars: { AT: `${x},${y},${z}` } }))
    },
  },
]

const texts = Object.fromEntries(TIPS.map(t => [t.id, fs.readFileSync(path.join(TIP_DIR, `${t.id}.txt`), 'utf8').trim()]))

// This turn's TIP lines, '' when none applies.
function renderTips() {
  const lines = []
  for (const tip of TIPS) {
    let subjects = []
    try { subjects = tip.detect() } catch (e) { console.warn(`  [TIP] ${tip.id} detect err:`, e.message) }
    for (const { key, vars } of subjects) {
      console.log(`  [TIP] ${tip.id}@${key}`)
      lines.push(`TIP(${tip.id}@${key}): ${texts[tip.id].replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)}`)
    }
  }
  return lines.join('\n')
}

module.exports = { renderTips }
