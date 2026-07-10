// Vitals actions — survival upkeep: eat (hunger) and sleep (rest)
const state = require('../state')
const { sleep, waitForEventOrTimeout } = require('../tick')
const { navigateTo } = require('../navigation')
const { sendChat, recordFailure } = require('../utils')
const { logGameEvent } = require('../memory')
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

async function doSleep() {
  const bot = state.bot
  const mcData = require('minecraft-data')(bot.version)
  const bedIds = Object.values(mcData.blocksByName)
    .filter(b => b.name.endsWith('_bed') || b.name === 'bed')
    .map(b => b.id)
  const bedPositions = bot.findBlocks({ matching: bedIds, maxDistance: 32, count: 5 })
  if (bedPositions.length === 0) {
    sendChat("Can't find a bed nearby!")
    recordFailure('sleep - no bed found')
    return
  }
  for (const pos of bedPositions) {
    try {
      const bedBlock = bot.blockAt(pos)
      if (!bedBlock) continue
      await navigateTo(pos.x, pos.y, pos.z, 3, 10000)
      await bot.sleep(bedBlock)
      console.log('  sleeping in bed')
      await waitForEventOrTimeout(bot, 'wake', 60000)
      console.log('  woke up')
      return
    } catch (e) {
      console.log(`  sleep failed at ${pos}: ${e.message}`)
    }
  }
  sendChat("Couldn't sleep in any nearby bed.")
}

module.exports = { doEat, doSleep }
