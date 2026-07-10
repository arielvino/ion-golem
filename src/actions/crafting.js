// Crafting actions — craft (smelting lives in ./smelting)
const { Vec3 } = require('vec3')
const state = require('../core/state')
const { sleep } = require('../core/tick')
const { navigateTo } = require('../navigation/navigation')
const { removeBlock, queryBlockMemoryFuzzy, searchContainersFor, logGameEvent, queryUtilityBlocks } = require('../world/memory')
const { reachDbUtilityBlock } = require('./utilityBlocks')
const { getInvMap, countMat, generalize, getBestRecipe } = require('../world/recipes')
const { c, color } = require('../lib/colors')
const { sendChat, normalizeItemName, recordFailure, fuzzyMatch, clearQueuedActions } = require('../core/utils')
const { isSmeltable } = require('./smelting')

// --- Crafting helpers ---

// Sum the count of an exact item name across all inventory stacks. Used to verify
// that bot.craft() actually produced output — it can resolve without completing the
// transaction (timing/race, partial batch), so "did not throw" is not proof of success.
function countInInventory(bot, name) {
  let total = 0
  for (const i of bot.inventory.items()) if (i.name === name) total += i.count
  return total
}

function recipeNeedsTable(recipe) {
  if (recipe.inShape) {
    const rows = recipe.inShape.length
    const cols = Math.max(...recipe.inShape.map(r => Array.isArray(r) ? r.length : 1))
    return rows > 2 || cols > 2
  }
  if (recipe.ingredients) {
    return recipe.ingredients.filter(id => id != null).length > 4
  }
  return true
}

// Wood-variant suffixes for generalized variant matching
const WOOD_VARIANT_SUFFIXES = [
  '_planks', '_door', '_fence', '_fence_gate', '_stairs', '_slab', '_boat',
  '_button', '_sign', '_hanging_sign', '_trapdoor', '_pressure_plate', '_chest_boat',
  '_log', '_wood',
]
const WOOD_TYPES = [
  'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
  'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak',
]
const COLOR_VARIANT_SUFFIXES = [
  '_bed', '_wool', '_carpet', '_banner', '_candle', '_concrete',
  '_concrete_powder', '_glazed_terracotta', '_stained_glass', '_stained_glass_pane',
  '_terracotta', '_shulker_box',
]
const COLOR_TYPES = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime',
  'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue',
  'brown', 'green', 'red', 'black',
]

async function resolveDependencies(itemId, batchCount, mcData, bot, useTable, depth) {
  if (depth > 3) return false

  const idToName = {}
  for (const [n, it] of Object.entries(mcData.itemsByName)) idToName[it.id] = n

  const rawRecipes = mcData.recipes[itemId]
  if (!rawRecipes || rawRecipes.length === 0) return false

  // Pick the recipe with most materials available
  const invMap = getInvMap()
  const best = getBestRecipe(itemId, invMap)
  if (!best) return false

  let resolved = false
  for (const [matName, needPerBatch] of Object.entries(best.needs)) {
    const totalNeed = needPerBatch * batchCount
    const have = countMat(matName, invMap)
    if (have >= totalNeed) continue

    const matItem = mcData.itemsByName[matName]
    if (!matItem) continue

    // Skip if this material requires smelting (no crafting recipe)
    const matRecipes = mcData.recipes[matItem.id]
    if (!matRecipes || matRecipes.length === 0) continue

    // Check if this material is smeltable — if so, skip auto-crafting it
    if (isSmeltable(matName)) continue

    const deficit = totalNeed - have
    // Figure out how many batches of this material we need
    // Each recipe produces result.count items
    const sampleRecipe = matRecipes[0]
    const outputCount = sampleRecipe.result?.count || 1
    const batches = Math.ceil(deficit / outputCount)

    console.log(`  [DEP] need ${deficit}x ${matName}, auto-crafting ${batches} batch(es)...`)

    // Recurse to resolve sub-dependencies first
    await resolveDependencies(matItem.id, batches, mcData, bot, useTable, depth + 1)

    // Now try to craft this intermediate
    let recipes = bot.recipesFor(matItem.id, null, 1, null)
    if (recipes.length === 0 && useTable) {
      recipes = bot.recipesFor(matItem.id, null, 1, useTable)
    }
    if (recipes.length > 0) {
      const matBefore = countInInventory(bot, matName)
      try {
        await bot.craft(recipes[0], batches, recipes.length > 0 && recipeNeedsTable(recipes[0]) ? useTable : null)
        const gained = countInInventory(bot, matName) - matBefore
        if (gained > 0) {
          logGameEvent('craft', matName, gained, null, null, null, { reason: 'dependency' })
          console.log(`  [DEP] auto-crafted ${gained}x ${matName}`)
          resolved = true
        } else {
          console.log(`  [DEP] ${matName} craft resolved but inventory gained nothing (expected ~${batches * outputCount}) — not counting as resolved`)
        }
      } catch (e) {
        console.log(`  [DEP] failed to auto-craft ${matName}: ${e.message}`)
      }
    }
  }
  return resolved
}

async function doCraft(targetName, count = 1) {
  const bot = state.bot
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch(e) {}
  const mcData = require('minecraft-data')(bot.version)
  const normalized = normalizeItemName(targetName)
  state.currentTask = `crafting ${count > 1 ? count + 'x ' : ''}${targetName}`

  let item = mcData.itemsByName[normalized]
  if (!item) {
    const match = Object.keys(mcData.itemsByName).find(n => fuzzyMatch(n, normalized))
    if (!match) { sendChat(`Don't know ${targetName}!`); state.currentTask = null; return false }
    item = mcData.itemsByName[match]
  }

  // Check if ALL raw recipes are 2x2 — if so, skip table acquisition entirely
  const rawRecipes = mcData.recipes[item.id] || []
  const allAre2x2 = rawRecipes.length > 0 && rawRecipes.every(r => !recipeNeedsTable(r))

  // Try 2x2 first (no table needed)
  let recipes = bot.recipesFor(item.id, null, 1, null)
  let useTable = null

  // If recipe needs a crafting table, look for one nearby (but don't auto-craft/place)
  if (recipes.length === 0 && !allAre2x2) {
    let ct = bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 6 })

    if (!ct) {
      // Check DB for known tables nearby
      const dbCt = queryUtilityBlocks(bot.entity.position, 10).filter(u => u.name === 'crafting_table')
      if (dbCt.length > 0) {
        const best = dbCt[0]
        const dist = Math.round(bot.entity.position.distanceTo(new Vec3(best.x, best.y, best.z)))
        if (dist <= 32) {
          console.log(`  [DB] known crafting_table at ${best.x},${best.y},${best.z} (${dist}m away)`)
          ct = await reachDbUtilityBlock('crafting_table', best, Math.max(15000, dist * 1500))
        }
      }
    }

    if (ct) {
      const ctDist = bot.entity.position.distanceTo(ct.position)
      if (ctDist > 4) {
        await navigateTo(ct.position.x, ct.position.y, ct.position.z, 3, 15000)
      }
      recipes = bot.recipesFor(item.id, null, 1, ct)
      useTable = ct
    }

    if (!ct) {
      // No table nearby — tell the AI to handle it
      const hasTableInv = bot.inventory.items().some(i => i.name === 'crafting_table')
      const hasPlanks = bot.inventory.items().filter(i => i.name.includes('planks')).reduce((s, i) => s + i.count, 0)
      let hint = `${targetName} needs a crafting table. `
      if (hasTableInv) hint += 'You have a crafting_table in inventory — place it first with [ACTION:place:crafting_table].'
      else if (hasPlanks >= 4) hint += 'You have planks — craft a crafting_table first (4 planks), then place it.'
      else hint += 'Craft a crafting_table (4 planks) and place it, or go to an existing one.'
      // Check DB for distant known tables
      const farTables = queryUtilityBlocks(bot.entity.position, 10).filter(u => u.name === 'crafting_table')
      if (farTables.length > 0) {
        const best = farTables[0]
        hint += ` Known table at ${best.x},${best.y},${best.z} (${Math.round(bot.entity.position.distanceTo(new Vec3(best.x, best.y, best.z)))}m).`
      }
      sendChat(hint)
      console.log(`  craft ${targetName}: no crafting table nearby`)
      recordFailure(`craft:${targetName} - need crafting table. ${hasTableInv ? 'Have one in inv.' : hasPlanks >= 4 ? 'Have planks for one.' : 'Need 4 planks.'}`)
      state.currentTask = null
      return false
    }
  }

  // --- Auto-resolve dependencies if no recipe found yet ---
  if (recipes.length === 0 && rawRecipes.length > 0) {
    console.log(`  [DEP] attempting dependency resolution for ${normalized}...`)
    const depResolved = await resolveDependencies(item.id, count, mcData, bot, useTable, 0)
    if (depResolved) {
      // Re-check recipes after auto-crafting intermediates
      recipes = bot.recipesFor(item.id, null, 1, null)
      if (recipes.length === 0 && useTable) {
        recipes = bot.recipesFor(item.id, null, 1, useTable)
      }
    }
  }

  // --- Generalized variant matching (replaces planks-only hack) ---
  if (recipes.length === 0) {
    let matchedSuffix = null
    for (const suffix of WOOD_VARIANT_SUFFIXES) {
      if (normalized.endsWith(suffix)) { matchedSuffix = suffix; break }
    }
    if (matchedSuffix) {
      // Scan inventory for available wood types
      const availableWoodTypes = new Set()
      for (const invItem of bot.inventory.items()) {
        for (const wt of WOOD_TYPES) {
          if (invItem.name.startsWith(wt + '_') && (invItem.name.includes('log') || invItem.name.includes('planks') || invItem.name.includes('wood'))) {
            availableWoodTypes.add(wt)
          }
        }
      }
      for (const wt of availableWoodTypes) {
        const variantName = wt + matchedSuffix
        const variantItem = mcData.itemsByName[variantName]
        if (!variantItem) continue
        let variantRecipes = bot.recipesFor(variantItem.id, null, 1, null)
        if (variantRecipes.length === 0 && useTable) {
          variantRecipes = bot.recipesFor(variantItem.id, null, 1, useTable)
        }
        // Also try dependency resolution for the variant
        if (variantRecipes.length === 0) {
          const variantRaw = mcData.recipes[variantItem.id] || []
          if (variantRaw.length > 0) {
            await resolveDependencies(variantItem.id, count, mcData, bot, useTable, 0)
            variantRecipes = bot.recipesFor(variantItem.id, null, 1, null)
            if (variantRecipes.length === 0 && useTable) {
              variantRecipes = bot.recipesFor(variantItem.id, null, 1, useTable)
            }
          }
        }
        if (variantRecipes.length > 0) {
          console.log(`  variant match: ${normalized} → ${variantName}`)
          item = variantItem
          recipes = variantRecipes
          break
        }
      }
    }
  }

  // --- Color variant matching (beds, wool, banners, etc.) ---
  if (recipes.length === 0) {
    let matchedColorSuffix = null
    for (const suffix of COLOR_VARIANT_SUFFIXES) {
      if (normalized.endsWith(suffix)) { matchedColorSuffix = suffix; break }
    }
    if (matchedColorSuffix) {
      // Try each color variant — some may have craftable recipes with current inventory
      for (const ct of COLOR_TYPES) {
        const variantName = ct + matchedColorSuffix
        const variantItem = mcData.itemsByName[variantName]
        if (!variantItem || variantItem.id === item.id) continue
        let variantRecipes = bot.recipesFor(variantItem.id, null, 1, null)
        if (variantRecipes.length === 0 && useTable) {
          variantRecipes = bot.recipesFor(variantItem.id, null, 1, useTable)
        }
        if (variantRecipes.length > 0) {
          console.log(`  color variant match: ${normalized} → ${variantName}`)
          item = variantItem
          recipes = variantRecipes
          break
        }
      }
    }
  }

  if (recipes.length === 0) {
    const hasCt = !!useTable
    const allRecipes = mcData.recipes[item.id]
    if (allRecipes && allRecipes.length > 0) {
      const invMap = getInvMap()
      const best = getBestRecipe(item.id, invMap)
      if (best) {
        const missing = []
        const missingMats = [] // for sourcing hints
        for (const [mat, cnt] of Object.entries(best.needs)) {
          const have = countMat(mat, invMap)
          if (have < cnt) {
            missing.push(`${generalize(mat)}(need ${cnt}, have ${have})`)
            missingMats.push(mat)
          }
        }
        const needsTable = best.needsTable && !hasCt
        const missingStr = missing.join(', ') + (needsTable ? ', crafting_table' : '')
        sendChat(`Can't craft ${targetName} yet — missing: ${missingStr}`)
        console.log(`  can't craft ${targetName} - missing materials: ${missingStr}`)

        // Dynamic sourcing hints
        const idToName = {}
        for (const [n, it] of Object.entries(mcData.itemsByName)) idToName[it.id] = n
        const sourceParts = []
        const botPos = bot.entity.position
        for (const mat of missingMats) {
          // Gather search terms dynamically
          const searchTerms = new Set()
          searchTerms.add(mat)
          // Recipe ingredients that produce this material
          const matItem = mcData.itemsByName[mat]
          if (matItem) {
            const matRecipes = mcData.recipes[matItem.id] || []
            for (const r of matRecipes) {
              const shape = r.inShape || []
              for (const row of shape) {
                for (const id of (Array.isArray(row) ? row : [row])) {
                  if (id != null && idToName[id]) searchTerms.add(idToName[id])
                }
              }
              if (r.ingredients) {
                for (const id of r.ingredients) {
                  if (id != null && idToName[id]) searchTerms.add(idToName[id])
                }
              }
            }
          }
          // Extract base word for fuzzy search (strip common suffixes/prefixes)
          const baseWord = mat
            .replace(/^(raw_|deepslate_|waxed_|polished_|cut_|smooth_|stripped_)/, '')
            .replace(/_(ingot|ore|block|nugget|planks|log|slab|stairs|wall|fence|button|plate|door|trapdoor|sign|boat|chest|wool|carpet|concrete|terracotta|glass|pane)$/, '')
          if (baseWord && baseWord !== mat && baseWord.length >= 3) searchTerms.add(baseWord)

          // Search block memory and containers
          const hits = []
          for (const term of searchTerms) {
            const blocks = queryBlockMemoryFuzzy(term, botPos, 3)
            for (const b of blocks) {
              if (!hits.some(h => h.x === b.x && h.y === b.y && h.z === b.z)) {
                hits.push({ label: `${b.name}@${b.x},${b.y},${b.z}(${Math.round(b.dist)}m)`, dist: b.dist })
              }
            }
            const cHits = searchContainersFor(term, botPos, 128)
            for (const ch of cHits) {
              hits.push({ label: `${ch.itemName}x${ch.count} in ${ch.type}@${ch.x},${ch.y},${ch.z}(${Math.round(ch.dist)}m)`, dist: ch.dist })
            }
          }
          hits.sort((a, b) => a.dist - b.dist)
          const top = hits.slice(0, 3).map(h => h.label)
          if (top.length > 0) sourceParts.push(`${generalize(mat)}: ${top.join(', ')}`)
        }

        let failMsg = `craft:${targetName} - missing: ${missingStr}.`
        if (sourceParts.length > 0) failMsg += ` FIND: ${sourceParts.join(' | ')}`
        else failMsg += ' Get the missing materials then try again!'
        recordFailure(failMsg)
      } else {
        sendChat(`Can't craft ${targetName} — missing materials!`)
        console.log(`  can't craft ${targetName} - missing materials (crafting_table_nearby=${hasCt})`)
        recordFailure(`craft:${targetName} - missing materials`)
      }
    } else {
      const hint = !hasCt ? ' Need crafting table nearby!' : ''
      sendChat(`Can't craft ${targetName} — no recipe exists!${hint}`)
      console.log(`  can't craft ${targetName} - no recipe in game data`)
      recordFailure(`craft:${targetName} - no recipe in game data`)
    }
    const before = state.actionQueue.length
    clearQueuedActions('craft:')
    if (state.actionQueue.length < before) console.log(`  cleared ${before - state.actionQueue.length} craft(s)`)
    state.currentTask = null
    return false
  }

  const craftedBefore = countInInventory(bot, item.name)
  try {
    await bot.craft(recipes[0], count, useTable)
    const outputCount = (recipes[0].result?.count || 1) * count
    // Verify the craft actually produced output. bot.craft() can resolve without
    // adding anything to the inventory (recipe matched but the window/ingredient
    // transaction didn't complete), and a silent no-op never enters the catch below.
    // Treat it as success only if the output item's count actually increased.
    const gained = countInInventory(bot, item.name) - craftedBefore
    if (gained <= 0) {
      console.error(color(c.red, `\n  craft ${item.name}: bot.craft() resolved but inventory gained nothing (expected ~${outputCount})`))
      sendChat(`Craft failed!`)
      recordFailure(`craft:${targetName} - bot.craft() resolved but produced nothing (expected ${outputCount}x ${item.name}). Check materials/table and retry.`)
      clearQueuedActions('craft:')
      state.currentTask = null
      return false
    }
    const label = gained > 1 ? `${gained}x ${item.name}` : item.name
    // Log consumed ingredients
    const consumed = {}
    if (recipes[0].ingredients) {
      for (const ing of recipes[0].ingredients) { if (ing) consumed[ing.name || `id${ing.id}`] = (consumed[ing.name || `id${ing.id}`] || 0) + count }
    } else if (recipes[0].delta) {
      for (const d of recipes[0].delta) { if (d.count < 0) consumed[d.name || `id${d.id}`] = -d.count * count }
    }
    logGameEvent('craft', item.name, gained, null, null, null, { consumed })
    console.log(color(c.green, `\n  crafted ${label}`))
    sendChat(`Crafted ${label}!`)
    const moreCrafts = state.actionQueue.some(a => a.actionStr.startsWith('craft:'))
    if (useTable && !moreCrafts) {
      // Only break the table if WE placed it (portable)
      const portable = state.portableCraftingTable
      if (portable) {
        const tp = useTable.position
        if (portable.x === tp.x && portable.y === tp.y && portable.z === tp.z) {
          try {
            await bot.dig(useTable)
            removeBlock(tp.x, tp.y, tp.z)
            logGameEvent('mine', 'crafting_table', 1, tp.x, tp.y, tp.z, { reason: 'pickup_portable' })
            console.log('  broke crafting table (portable)')
            // removeBlock already handles DB cleanup
            state.portableCraftingTable = null
            await sleep(400)
            const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(tp) < 4)
            if (drop) await navigateTo(drop.position.x, drop.position.y, drop.position.z, 1, 3000, { noReachCheck: true })
          } catch (e) { console.warn('  [CRAFT] portable table pickup err:', e.message) }
        }
      }
    }
    state.currentTask = null
    return true
  } catch (err) {
    console.error(`  craft err: ${err.message}`)
    sendChat(`Craft failed!`)
    clearQueuedActions('craft:')
  }
  state.currentTask = null
  return false
}

module.exports = { doCraft }
