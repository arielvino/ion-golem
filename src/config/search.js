// Search-distance tiers (in blocks) for "find / scan nearby" queries.
//
// These name the recurring radii used when querying remembered blocks, utility
// blocks and containers around the bot, so the intent ("nearby" vs "far") is
// explicit instead of a bare 16/20/32/64.
//
// NOTE: the literal 16 used as a *chunk-section size* (e.g. `cx * 16` in
// chunkScan.js / memory.js) is a Minecraft constant, NOT a search tier — those
// stay as-is and must not be replaced with SEARCH_NEARBY.

module.exports = {
  SEARCH_NEARBY: 16,    // immediate surroundings (e.g. pathfinding-corridor data)
  SEARCH_UTILITY: 20,   // utility-block lookups (furnaces, crafting tables…)
  SEARCH_STANDARD: 32,  // typical mid-range scan radius
  SEARCH_FAR: 64,       // long-range lookups (remembered containers)
}
