// Optimistic block predicates over the honest `blocks` DB. null = unknown.
//
// Knowledge comes ONLY from the honest `blocks` DB (LOS-seen, fed by the omni
// surveyForNav). These predicates are OPTIMISTIC about the unknown — they do not
// pretend to see fog, they just refuse to treat fog as a wall:
//   • unknown foot/head  → assume passable (the frontier is traversable)
//   • unknown floor      → assume solid    (ground presumed to continue)
//   • unknown            → not a hazard    (liveStep catches real lava/drops)
// Shared by the planner (pathplanner.js) and the executors (navigation.js).
const { PASSABLE, HAZARDS } = require('../perception/vision')
const { SURFACE } = require('../config/blocks')
const { dbBlock } = require('./atomicSteps')

function _pPassable(x, y, z) { const n = dbBlock(x, y, z); return n === null ? true : PASSABLE.has(n) }
function _pHazard(x, y, z)   { const n = dbBlock(x, y, z); return n !== null && HAZARDS.has(n) }
function _pSurface(x, y, z)  { const n = dbBlock(x, y, z); return n !== null && SURFACE.has(n) }
// unknown floor → assume solid (optimistic ground); seen-passable → not floor
function _pFloor(x, y, z)        { const n = dbBlock(x, y, z); return n === null ? true : (!PASSABLE.has(n) || SURFACE.has(n)) }
function _pKnownSolid(x, y, z)   { const n = dbBlock(x, y, z); return n !== null && !PASSABLE.has(n) }
function _pKnownClear(x, y, z)   { const n = dbBlock(x, y, z); return n !== null && PASSABLE.has(n) }

module.exports = { _pPassable, _pHazard, _pSurface, _pFloor, _pKnownSolid, _pKnownClear }
