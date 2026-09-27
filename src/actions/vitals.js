// Vitals actions — survival upkeep: eat (hunger) and sleep (rest)
const state = require('../core/state')
const { sleep, waitForEventOrTimeout } = require('../core/tick')
const { navigateTo } = require('../navigation/navigation')
const { sendChat, recordFailure } = require('../core/utils')
const { Vec3 } = require('vec3')
const { logGameEvent, queryBlockMemory } = require('../world/memory')
const { FOOD_FULL } = require('../config/safety')

async function doEat() {
  const bot = state.bot
  const foods = bot.inventory.items().filter(i => i.foodRecovery > 0)
  if (foods.length === 0) { sendChat("No food!"); return }
  if (bot.food >= FOOD_FULL) { console.log('  food bar full, skipping eat'); return }
  try {
    bot.clearControlStates()
    await sleep(100)
    await bot.equip(foods[0], 'hand')
    await sleep(200)
    await bot.consume()
    logGameEvent('eat', foods[0].name, 1)
    console.log(`  ate ${foods[0].name}, food=${bot.food}/20 HP=${Math.round(bot.health)}/20`)
  } catch (err) {
    console.error(`  eat err: ${err.message} (food=${bot.food}/20, item=${foods[0]?.name})`)
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
      await navigateTo(x, y, z, 3, 10000)
      const bedBlock = bot.blockAt(new Vec3(x, y, z))
      if (!bedBlock || !bedBlock.name.endsWith('_bed')) { errors.push(`${x},${y},${z}: no bed there any more`); continue }
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

module.exports = { doEat, doSleep }
