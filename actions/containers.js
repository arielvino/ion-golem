// Container helpers — shared furnace/storage state utilities
const { saveContainerState } = require('../memory')

/** Snapshot a furnace's slots into a plain {input, fuel, output} contents object
 *  (each slot is {name, count} or null). */
function getFurnaceState(furnace) {
  const slot = (it) => it ? { name: it.name, count: it.count } : null
  return {
    input: slot(furnace.inputItem()),
    fuel: slot(furnace.fuelItem()),
    output: slot(furnace.outputItem()),
  }
}

/** Persist a storage container's current items to the containers DB */
function saveContainerItems(pos, type, container) {
  saveContainerState(pos.x, pos.y, pos.z, type, {
    items: container.containerItems().map(i => ({ name: i.name, count: i.count })),
  })
}

module.exports = { getFurnaceState, saveContainerItems }
