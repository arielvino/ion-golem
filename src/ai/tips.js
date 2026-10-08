// tips.js — game knowledge shown to the model once, the turn its situation first arises.
//
// The system prompt is sent every turn, so knowledge that only matters in a rare
// situation (a spawner in a stronghold) is either missing from it or paid for on
// every turn. A tip pairs a detector with a text in tips/<id>.txt: the detector reads
// what the bot perceives right now (the LOS survey, never bot.blockAt), and the text
// rides along in that turn's input only. Each subject (one spawner) is tipped once
// per process, so a fight next to it doesn't repeat the same paragraph every turn.
const fs = require('fs')
const path = require('path')
const { getLastSurvey } = require('../perception/visibility')

const TIP_DIR = path.join(__dirname, 'tips')

// Every subject of a tip in sight now, as { key, vars }. key identifies the subject
// across turns; vars fill the {NAME} slots of the text.
const TIPS = [
  {
    id: 'spawner',
    detect() {
      const rec = getLastSurvey()?.blocks?.spawner
      if (!rec?.nearest) return []
      const { x, y, z } = rec.nearest
      return [{ key: `${x},${y},${z}`, vars: { AT: `${x},${y},${z}` } }]
    },
  },
]

const texts = Object.fromEntries(TIPS.map(t => [t.id, fs.readFileSync(path.join(TIP_DIR, `${t.id}.txt`), 'utf8').trim()]))
const shown = new Set()

// This turn's TIP lines ('' when nothing new is in sight) and their ids. A tip only
// counts as shown once markTipsShown(ids) confirms the model answered that turn: an
// interrupted turn's input is thrown away, and with it a tip marked too early.
function renderTips() {
  const lines = [], ids = []
  for (const tip of TIPS) {
    let subjects = []
    try { subjects = tip.detect() } catch (e) { console.warn(`  [TIP] ${tip.id} detect err:`, e.message) }
    for (const { key, vars } of subjects) {
      const id = `${tip.id}@${key}`
      if (shown.has(id)) continue
      ids.push(id)
      lines.push(`TIP(${id}): ${texts[tip.id].replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)}`)
    }
  }
  return { text: lines.join('\n'), ids }
}

function markTipsShown(ids) {
  for (const id of ids) {
    shown.add(id)
    console.log(`  [TIP] shown ${id}`)
  }
}

module.exports = { renderTips, markTipsShown }
