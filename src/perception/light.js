// light.js — can a cell be seen by its light? sight.js's rule (see its header), as a
// per-cell test for the vision paths that don't cast sight.js's rays (vision.js,
// visibility.js):
//   - a solid block shows by the face a sightline reaches, and that face's light is the
//     light of the cell in front of it (an opaque block has no light of its own),
//   - a see-through cell (air, water, plants, glass) shows by its own light,
//   - dark cells a sightline only passes don't hide a lit block beyond them,
//   - light sources always show.
// Effective light = max(block light, sky light - night darkening). Overworld only: the
// Nether and the End are dimly lit everywhere.
const { skyDarken, emitTable, opaqueTable, MIN_LIGHT } = require('./sight')

// → null outside the overworld (nothing is too dark to see there), else
//   { lit(x, y, z): is the cell's light enough to see by,
//     faceLit(stateId, x, y, z): for the block there, a test (fx, fy, fz) → is it seen
//       through the face whose front cell that is; null when it always shows (a light
//       source) }.
// Reads light straight from the chunk sections, like sight.js's snapshot; an unloaded
// cell is dark.
function lightGate(bot) {
  if (!/overworld/.test(bot.game?.dimension || '')) return null
  const darken = skyDarken(bot.time?.timeOfDay ?? 6000, bot.rainState || 0, bot.thunderState || 0)
  const emits = emitTable(bot.registry), opaque = opaqueTable(bot.registry)
  const minY = bot.game.minY
  let lcx = NaN, lcz = NaN, col = null
  function level(x, y, z) {
    const cx = x >> 4, cz = z >> 4
    if (cx !== lcx || cz !== lcz) { col = bot.world.getColumn(cx, cz); lcx = cx; lcz = cz }
    if (!col) return 0
    const ry = y - minY
    // Light sections run one below the block sections: index sy + 1.
    const s = (ry >> 4) + 1, i = ((ry & 15) << 8) | ((z & 15) << 4) | (x & 15)
    const bl = col.blockLightSections?.[s], sl = col.skyLightSections?.[s]
    return Math.max(bl ? bl.get(i) : 0, (sl ? sl.get(i) : 0) - darken)
  }
  const lit = (x, y, z) => level(x, y, z) >= MIN_LIGHT
  const faceLit = (stateId, x, y, z) => {
    if (stateId != null && emits[stateId]) return null
    if (stateId != null && !opaque[stateId]) return () => lit(x, y, z)
    return lit
  }
  return { lit, faceLit }
}

module.exports = { lightGate }
