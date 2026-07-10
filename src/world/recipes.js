// Recipe helpers — inventory counting, material generalization, recipe lookup
const state = require('../core/state')

function getInvMap() {
  const m = {}
  for (const i of state.bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count
  return m
}

function getIdToName() {
  const mcData = require('minecraft-data')(state.bot.version)
  const m = {}
  for (const [n, it] of Object.entries(mcData.itemsByName)) m[it.id] = n
  return m
}

function countMat(matName, invMap) {
  if (invMap[matName]) return invMap[matName]
  const suffix = matName.replace(/^[a-z]+_/, '_')
  let total = 0
  for (const [k, v] of Object.entries(invMap)) {
    if (k.endsWith(suffix) || k === matName) total += v
  }
  return total
}

function generalize(matName) {
  if (matName.endsWith('_planks')) return 'any_planks'
  if (matName.endsWith('_log')) return 'any_log'
  return matName
}

function getBestRecipe(itemId, invMap) {
  const mcData = require('minecraft-data')(state.bot.version)
  const idToName = getIdToName()
  const recipes = mcData.recipes[itemId]
  if (!recipes || recipes.length === 0) return null
  let best = null
  for (const r of recipes) {
    const needs = {}
    const shape = r.inShape || []
    for (const row of shape) {
      for (const id of (Array.isArray(row) ? row : [row])) {
        if (id != null) { const n = idToName[id] || String(id); needs[n] = (needs[n] || 0) + 1 }
      }
    }
    if (r.ingredients) {
      for (const id of r.ingredients) {
        if (id != null) { const n = idToName[id] || String(id); needs[n] = (needs[n] || 0) + 1 }
      }
    }
    const needsTable = r.inShape && r.inShape[0] && r.inShape[0].length === 3
    let missingTotal = 0
    if (invMap) {
      for (const [mat, count] of Object.entries(needs)) {
        const have = countMat(mat, invMap)
        if (have < count) missingTotal += (count - have)
      }
    }
    if (!best || missingTotal < best.missingCount || (missingTotal === best.missingCount)) {
      best = { needs, needsTable, missingCount: missingTotal }
    }
    if (missingTotal === 0) break
  }
  return best
}

module.exports = { getInvMap, getIdToName, countMat, generalize, getBestRecipe }
