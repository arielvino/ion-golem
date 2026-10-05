// Stable short names for entities: cow#a3f9. Two cows both read "cow" in a name
// list, so across turns the model can't tell "the same cow" from "another cow",
// and "attack:cow" hits whichever is nearest. The tag is the first 4 hex digits of
// the entity's UUID, which the server keeps for the entity's whole life (reloads
// and restarts included), so the same tag also means the same animal in notes,
// records and the events DB. Players are excluded — their names are unique.
const state = require('../core/state')

function shortId(e) {
  const hex = String(e.uuid || '').replace(/-/g, '').toLowerCase()
  return hex.length >= 4 ? hex.slice(0, 4) : `e${e.id}`
}

// 'drop:cobblestone' for item entities, else the entity's own name.
function baseName(e) {
  const n = e.name || '?'
  if (n === 'item' || n === 'Item' || n === 'item_stack') {
    try {
      const drop = e.getDroppedItem()
      if (drop) return `drop:${drop.name}`
    } catch (_) { /* entity may lack drop data */ }
  }
  return n
}

function entityTag(e) {
  if (e.username) return e.username
  return `${baseName(e)}#${shortId(e)}`
}

// The '#xxxx' part of an action argument like 'cow#a3f9', or null.
function tagOf(spec) {
  const m = /#([0-9a-z]+)\s*$/i.exec(String(spec || ''))
  return m ? m[1].toLowerCase() : null
}

// The live entity a tagged spec names ('cow#a3f9', or just '#a3f9'), or null.
function findTagged(spec) {
  const id = tagOf(spec)
  if (!id) return null
  const bot = state.bot
  return Object.values(bot.entities).find(e => e !== bot.entity && !e.username && shortId(e) === id) || null
}

module.exports = { entityTag, baseName, shortId, tagOf, findTagged }
