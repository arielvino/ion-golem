// riders.js — a player riding a vehicle is where the vehicle is.
// The server stops sending a passenger's own position while it rides: it moves the
// vehicle, and the vanilla client places each rider on its vehicle every frame.
// Mineflayer doesn't, so another player's entity kept the spot where it mounted while
// its boat sailed away (#79), and PLAYERS=, follow and come all aimed there. Copy the
// vehicle's position onto its passengers whenever the vehicle moves.

function bind(bot) {
  bot.on('entityMoved', (vehicle) => {
    const riders = vehicle.passengers
    if (!riders || riders.length === 0) return
    for (const p of riders) {
      // The bot's own position is the physics plugin's, which already rides along.
      if (!p || p === bot.entity || !p.position) continue
      p.position.set(vehicle.position.x, vehicle.position.y, vehicle.position.z)
    }
  })
}

module.exports = { bind }
