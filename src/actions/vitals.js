// Vitals actions — survival upkeep: eat (hunger) and sleep (rest)
const state = require('../core/state')
const { sleep, waitForEventOrTimeout } = require('../core/tick')
const { reachKnownBlock } = require('../perception/touch')
const { sendChat, recordFailure } = require('../core/utils')
const { Vec3 } = require('vec3')
const { logGameEvent, queryBlockMemory } = require('../world/memory')
const { FOOD_FULL } = require('../config/safety')

// Food that does harm (poison, nausea, hunger, random teleport): eaten only when nothing
// else is in the inventory.
const HARMFUL_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])

// Edible inventory items, best first. Food values come from the registry's foods table
// (minecraft-data), keyed by item name — items carry no food data themselves.
function edibleFoods(bot) {
  const foods = bot.registry.foodsByName || {}
  const edible = bot.inventory.items().filter(i => foods[i.name])
  const q = (i) => (HARMFUL_FOOD.has(i.name) ? -100 : 0) + (foods[i.name].effectiveQuality || foods[i.name].foodPoints || 0)
  return edible.sort((a, b) => q(b) - q(a))
}

async function doEat() {
  const bot = state.bot
  const foods = edibleFoods(bot)
  if (foods.length === 0) {
    sendChat("No food!")
    recordFailure('eat - nothing edible in the inventory')
    return false
  }
  if (bot.food >= FOOD_FULL) { console.log('  food bar full, skipping eat'); return true }
  const food = foods[0]
  const before = bot.food
  try {
    bot.clearControlStates()
    await sleep(100)
    await bot.equip(food, 'hand')
    await sleep(200)
    await bot.consume()
    logGameEvent('eat', food.name, 1)
    console.log(`  ate ${food.name}, food=${before}→${bot.food}/20 HP=${Math.round(bot.health)}/20`)
    return true
  } catch (err) {
    console.error(`  eat err: ${err.message} (food=${bot.food}/20, item=${food.name})`)
    recordFailure(`eat - eating ${food.name} failed: ${err.message}`)
    return false
  }
}

// Beds come from the block DB (beds the bot has actually seen), not a
// bot.findBlocks scan, which would find beds behind walls.
async function doSleep() {
  const bot = state.bot
  const bedNames = Object.keys(bot.registry.blocksByName).filter(n => n.endsWith('_bed'))
  const beds = queryBlockMemory(bedNames, bot.entity.position).filter(b => b.dist <= 32).slice(0, 5)
  if (beds.length === 0) {
    recordFailure('sleep: no bed seen within 32 blocks — craft and place one (3 wool + 3 planks)')
    return false
  }
  const errors = []
  for (const { x, y, z } of beds) {
    try {
      const r = await reachKnownBlock(new Vec3(x, y, z), b => b.name.endsWith('_bed'), 'bed', 10000)
      if (!r.block) { errors.push(r.why); continue }
      const bedBlock = r.block
      await bot.sleep(bedBlock)
      console.log('  sleeping in bed')
      await waitForEventOrTimeout(bot, 'wake', 60000)
      console.log('  woke up')
      return true
    } catch (e) {
      console.log(`  sleep failed at ${x},${y},${z}: ${e.message}`)
      errors.push(`${x},${y},${z}: ${e.message}`)
    }
  }
  recordFailure(`sleep: couldn't sleep in any nearby bed (${errors.join('; ')})`)
  return false
}

module.exports = { doEat, doSleep, edibleFoods }
