// Smelting actions — smelt items in a furnace, plus the smeltable-item classifier
const { Vec3 } = require('vec3')
const state = require('../state')
const { tickWait, AbortError, isAborted } = require('../tick')
const { navigateTo } = require('../navigation')
const { saveContainerState, logGameEvent, queryUtilityBlocks } = require('../memory')
const { reachDbUtilityBlock } = require('./utilityBlocks')
const { fuelRates, fuelNames } = require('../config/constants')
const smeltableData = require('../config/smeltable.json')
const { c, color } = require('../lib/colors')
const { sendChat, normalizeItemName, recordFailure, fuzzyMatch } = require('../utils')
const { getFurnaceState } = require('./containers')

// Items that can be smelted in a furnace (driven by config/smeltable.json)
const smeltableExact = new Set(smeltableData.exact)
const gearRegex = new RegExp(`^(${smeltableData.gearPatterns.join('|')})_(${smeltableData.gearTypes.join('|')})$`)

function isSmeltable(itemName) {
  if (smeltableExact.has(itemName)) return true
  for (const p of smeltableData.prefixes) { if (itemName.startsWith(p)) return true }
  for (const s of smeltableData.suffixes) { if (itemName.endsWith(s)) return true }
  for (const c of smeltableData.contains) { if (itemName.includes(c)) return true }
  if (gearRegex.test(itemName)) return true
  return false
}

async function doSmelt(targetName) {
  const bot = state.bot
  const mcData = require('minecraft-data')(bot.version)
  const normalized = normalizeItemName(targetName)
  state.currentTask = `smelting ${targetName}`
  let smeltOk = false  // set true once we successfully load the furnace and run the smelt

  let furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 64 })

  if (!furnaceBlock) {
    // Search DB for known furnaces
    const dbFurnaces = queryUtilityBlocks(bot.entity.position, 10).filter(u => u.name === 'furnace')
    for (const f of dbFurnaces) {
      const dist = Math.round(bot.entity.position.distanceTo(new Vec3(f.x, f.y, f.z)))
      console.log(`  [DB] known furnace at ${f.x},${f.y},${f.z} (${dist}m away)`)
      if (dist < 200) {
        const yD = Math.abs(f.y - bot.entity.position.y)
        furnaceBlock = await reachDbUtilityBlock('furnace', f, Math.max(30000, dist * 2000 + yD * 3000))
        if (furnaceBlock) break
      }
    }
  }

  if (!furnaceBlock) {
    sendChat('No furnace found! Craft one with 8 cobblestone.')
    recordFailure('smelt - no furnace available. Craft a furnace first (8 cobblestone).')
    state.currentTask = null; return false
  }

  await navigateTo(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2, 45000)
  if (isAborted()) { state.currentTask = null; return false }

  function getFuelRate(name) {
    if (fuelRates[name]) return fuelRates[name]
    if (name.includes('planks') || name.includes('slab')) return 1.5
    if (name.includes('log') || name.includes('wood') || name.includes('stem')) return 1.5
    return 1
  }

  try {
    const furnace = await bot.openFurnace(furnaceBlock)

    const fPos = furnaceBlock.position
    function cacheFurnaceState() {
      try {
        saveContainerState(fPos.x, fPos.y, fPos.z, 'furnace', getFurnaceState(furnace))
      } catch (e) { console.warn('  [SMELT] furnace state save err:', e.message) }
    }

    const existingInput = furnace.inputItem()
    const existingFuel = furnace.fuelItem()
    const existingOutput = furnace.outputItem()
    cacheFurnaceState()

    if (existingOutput) {
      await furnace.takeOutput()
      console.log(`  collected ${existingOutput.count}x ${existingOutput.name} from furnace`)
    }

    // Find input item — prefer exact match, then fuzzy
    let inputItem = bot.inventory.items().find(i => i.name === normalized)
    if (!inputItem) inputItem = bot.inventory.items().find(i => fuzzyMatch(i.name, normalized))

    // Validate that the item is actually smeltable
    if (inputItem && !isSmeltable(inputItem.name)) {
      sendChat(`Can't smelt ${inputItem.name} — not a valid furnace input!`)
      console.log(`  rejected smelting ${inputItem.name} (not smeltable)`)
      recordFailure(`smelt:${targetName} - ${inputItem.name} cannot be smelted. Smeltable items: raw ores, ore blocks, food (raw_beef etc), logs (→charcoal), sand, cobblestone, clay_ball, iron/gold gear (→nuggets).`)
      furnace.close()
      state.currentTask = null
      return false
    }

    const itemsToSmelt = existingInput ? existingInput.count : 0
    const newItems = inputItem ? inputItem.count : 0
    const totalToSmelt = itemsToSmelt + newItems

    if (totalToSmelt === 0) {
      sendChat(`Don't have ${targetName} to smelt and furnace is empty!`)
      furnace.close()
      state.currentTask = null
      return false
    }

    if (inputItem) {
      await furnace.putInput(inputItem.type, inputItem.metadata, inputItem.count)
      console.log(`  loaded ${inputItem.count}x ${inputItem.name} into furnace`)
    }

    let fuel = null
    for (const fname of fuelNames) {
      fuel = bot.inventory.items().find(i => i.name === fname)
      if (fuel) break
    }
    if (!fuel) {
      fuel = bot.inventory.items().find(i =>
        i.name.includes('coal') || i.name.includes('planks') || i.name.includes('log'))
    }

    if (!fuel && !existingFuel) {
      sendChat(`Furnace loaded but no fuel! Need coal or wood.`)
      furnace.close()
      state.currentTask = null
      return false
    }

    function findFuel() {
      for (const fname of fuelNames) {
        const f = bot.inventory.items().find(i => i.name === fname)
        if (f) return f
      }
      return bot.inventory.items().find(i =>
        i.name.includes('coal') || i.name.includes('planks') || i.name.includes('log'))
    }

    async function addFuel(itemsNeeded) {
      const f = findFuel()
      if (!f) return false
      try {
        const rate = getFuelRate(f.name)
        const needed = Math.min(Math.ceil(itemsNeeded / rate), f.count)
        await furnace.putFuel(f.type, f.metadata, needed)
        console.log(`  loaded ${needed}x ${f.name} as fuel (rate: ${rate} items/fuel)`)
        return true
      } catch (e) {
        console.log(`  fuel load failed: ${e.message}`)
        return false
      }
    }

    if (fuel) {
      const ok = await addFuel(totalToSmelt)
      if (ok) sendChat(`Smelting ${totalToSmelt}x ${normalized}...`)
      else sendChat(`Smelting ${totalToSmelt}x ${normalized} (fuel issue, will retry)...`)
    } else {
      sendChat(`Smelting ${totalToSmelt}x ${normalized} (fuel already in furnace)...`)
    }

    const maxWait = Math.min(totalToSmelt * 11000 + 10000, 300000)
    const start = Date.now()
    let lastOutputCount = 0
    let fuelFailCount = 0

    while (Date.now() - start < maxWait) {
      try { await tickWait(5000) } catch(e) { break }

      try {
        const curInput = furnace.inputItem()
        const curOutput = furnace.outputItem()
        const curFuel = furnace.fuelItem()

        if (!curInput) { console.log('  furnace input empty, smelting done'); break }

        // Output slot full (64) — furnace stalls. Collect output and continue.
        if (curOutput && curOutput.count >= 64 && curInput) {
          console.log(`  output full (${curOutput.count}), collecting mid-smelt`)
          await furnace.takeOutput()
          logGameEvent('smelt', curOutput.name, curOutput.count, fPos.x, fPos.y, fPos.z,
            { input: normalized, furnace_type: furnaceBlock.name, fuel: findFuel()?.name || 'unknown', mid_collect: true })
          lastOutputCount = 0
        }

        if (!curFuel && curInput) {
          const ok = await addFuel(curInput.count)
          if (!ok) {
            fuelFailCount++
            if (fuelFailCount >= 2) { console.log('  out of fuel, stopping'); break }
          } else { fuelFailCount = 0 }
        }

        cacheFurnaceState()
        if (curOutput && curOutput.count !== lastOutputCount) {
          console.log(`  progress: ${curOutput.count} smelted, ${curInput ? curInput.count : 0} remaining`)
          lastOutputCount = curOutput.count
        }
      } catch (e) {
        console.log(`  furnace check err: ${e.message}`)
      }
    }

    try {
      const finalOutput = furnace.outputItem()
      if (finalOutput) {
        await furnace.takeOutput()
        logGameEvent('smelt', finalOutput.name, finalOutput.count, fPos.x, fPos.y, fPos.z,
          { input: normalized, furnace_type: furnaceBlock.name, fuel: findFuel()?.name || 'unknown' })
        console.log(color(c.green, `\n  smelted ${finalOutput.name} x${finalOutput.count}`))
        sendChat(`Got ${finalOutput.count}x ${finalOutput.name}!`)
      } else {
        console.log('  no output to collect')
      }
    } catch (e) {
      console.log(`  output collect err: ${e.message}`)
    }

    cacheFurnaceState()
    furnace.close()
    // (furnace state tracked in containers DB)
    smeltOk = true  // input + fuel loaded and the smelt loop ran to completion
  } catch (err) {
    if (err instanceof AbortError) throw err
    console.error('  smelt err:', err.message)
    try { if (state.bot.currentWindow) state.bot.closeWindow(state.bot.currentWindow) } catch(e) {}
    // (furnace state tracked in containers DB)
  }
  state.currentTask = null
  return smeltOk
}

module.exports = { doSmelt, isSmeltable }
