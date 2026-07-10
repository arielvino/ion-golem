#!/usr/bin/env node
// MCP stdio server — exposes bot query tools to the AI model
// Runs as a subprocess spawned by the Claude CLI via --mcp-config
// Reads the bot's SQLite database directly (WAL mode supports concurrent readers)

const path = require('path')
const Database = require('better-sqlite3')
const sdkBase = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'server')
const { McpServer } = require(path.join(sdkBase, 'mcp.js'))
const { StdioServerTransport } = require(path.join(sdkBase, 'stdio.js'))
const { z } = require('zod')
const { parseBlueprint } = require('./lib/blueprint')

// Format a world tick + day as in-game time. game_tick = world age in ticks
// (20/sec); timeOfDay = tick % 24000. MC day starts at 0 = 6:00 AM, so
// hour = floor((timeOfDay/1000 + 6) % 24). Returns e.g. "day3 06:00".
function gameTimeString(game_tick, game_day) {
  const timeOfDay = game_tick % 24000
  const hour = Math.floor((timeOfDay / 1000 + 6) % 24)
  const minute = Math.floor(((timeOfDay % 1000) / 1000) * 60)
  return `day${game_day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// DB path passed via environment variable from ai-provider.js
const DB_PATH = process.env.BOT_DB_PATH
if (!DB_PATH) {
  process.stderr.write('MCP server: BOT_DB_PATH not set\n')
  process.exit(1)
}

let db
try {
  db = new Database(DB_PATH, { readonly: true })
  db.pragma('journal_mode = WAL')
} catch (e) {
  process.stderr.write(`MCP server: failed to open DB: ${e.message}\n`)
  process.exit(1)
}

// Prepared statements
const stmts = {
  getStructures: db.prepare(`
    SELECT s.id, s.name, s.created_at, s.blueprint, s.origin_x, s.origin_y, s.origin_z,
      MIN(p.x) as x1, MAX(p.x) as x2, MIN(p.y) as y1, MAX(p.y) as y2, MIN(p.z) as z1, MAX(p.z) as z2,
      COUNT(p.x) as block_count
    FROM structures s LEFT JOIN placed_blocks p ON p.structure_id = s.id
    GROUP BY s.id ORDER BY s.created_at DESC
  `),
  getStructureBlocks: db.prepare(`
    SELECT x, y, z, bp_x, bp_y, bp_z FROM placed_blocks WHERE structure_id = ?
  `),
  getStructureById: db.prepare(`
    SELECT id, name, created_at, blueprint, origin_x, origin_y, origin_z FROM structures WHERE id = ?
  `),
  // Biome queries
  listBiomes: db.prepare(`
    SELECT biome, COUNT(*) as section_count,
      MIN(chunk_x) as min_cx, MAX(chunk_x) as max_cx,
      MIN(chunk_y) as min_cy, MAX(chunk_y) as max_cy,
      MIN(chunk_z) as min_cz, MAX(chunk_z) as max_cz
    FROM chunk_biomes GROUP BY biome ORDER BY section_count DESC
  `),
  locateBiome: db.prepare(`
    SELECT chunk_x, chunk_y, chunk_z, seen_at FROM chunk_biomes WHERE biome LIKE ?
    ORDER BY (chunk_x - ?) * (chunk_x - ?) + (chunk_z - ?) * (chunk_z - ?) ASC LIMIT ?
  `),
  // Block queries
  getBlockAt: db.prepare(`SELECT name, reachable FROM blocks WHERE x=? AND y=? AND z=?`),
  getBlocksInRegion: db.prepare(`SELECT x, y, z, name FROM blocks WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ? LIMIT ?`),
  // Inventory
  getInventory: db.prepare(`SELECT slot, name, count FROM bot_inventory`),
  // Containers
  getAllContainers: db.prepare(`SELECT x, y, z, type, contents FROM containers`),
  // Chat log
  recentChat: db.prepare(`SELECT id, game_tick, game_day, type, username, message FROM chat_log ORDER BY game_tick DESC LIMIT ?`),
  searchChat: db.prepare(`SELECT id, game_tick, game_day, type, username, message FROM chat_log WHERE message LIKE ? ORDER BY game_tick DESC LIMIT ?`),
  chatByUser: db.prepare(`SELECT id, game_tick, game_day, type, username, message FROM chat_log WHERE username = ? ORDER BY game_tick DESC LIMIT ?`),
  chatSinceTick: db.prepare(`SELECT id, game_tick, game_day, type, username, message FROM chat_log WHERE game_tick > ? ORDER BY game_tick ASC LIMIT ?`),
  // Events
  recentEvents: db.prepare(`SELECT id, game_tick, game_day, type, target, count, x, y, z, detail FROM events ORDER BY game_tick DESC LIMIT ?`),
  recentEventsByType: db.prepare(`SELECT id, game_tick, game_day, type, target, count, x, y, z, detail FROM events WHERE type = ? ORDER BY game_tick DESC LIMIT ?`),
  searchEvents: db.prepare(`SELECT id, game_tick, game_day, type, target, count, x, y, z, detail FROM events WHERE target LIKE ? ORDER BY game_tick DESC LIMIT ?`),
  searchEventsTyped: db.prepare(`SELECT id, game_tick, game_day, type, target, count, x, y, z, detail FROM events WHERE target LIKE ? AND type = ? ORDER BY game_tick DESC LIMIT ?`),
  eventStats: db.prepare(`SELECT type, target, SUM(count) as total, COUNT(*) as times FROM events GROUP BY type, target ORDER BY type, total DESC`),
  eventStatsType: db.prepare(`SELECT target, SUM(count) as total, COUNT(*) as times FROM events WHERE type = ? GROUP BY target ORDER BY total DESC`),
  eventsNear: db.prepare(`SELECT id, game_tick, game_day, type, target, count, x, y, z, detail FROM events WHERE x IS NOT NULL AND (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) < ? ORDER BY game_tick DESC LIMIT ?`),
  // Task log
  recentTasks: db.prepare(`SELECT id, game_tick, game_day, action, task, detail, stack_after FROM task_log ORDER BY game_tick DESC LIMIT ?`),
  searchTasks: db.prepare(`SELECT id, game_tick, game_day, action, task, detail, stack_after FROM task_log WHERE task LIKE ? OR detail LIKE ? OR stack_after LIKE ? ORDER BY game_tick DESC LIMIT ?`),
}

// --- MCP Server setup ---
const server = new McpServer({
  name: 'minecraft-bot',
  version: '1.0.0',
})

// Tool: query_structures — list all structures the bot has built
server.tool(
  'query_structures',
  'List all structures the bot has built, with location, bounds, and block count. Use to find existing builds before navigating or resuming construction.',
  {},
  async () => {
    const rows = stmts.getStructures.all()
    const structures = rows.map(s => ({
      id: s.id,
      name: s.name,
      origin: s.origin_x != null ? { x: s.origin_x, y: s.origin_y, z: s.origin_z } : null,
      bounds: s.x1 != null ? {
        min: { x: s.x1, y: s.y1, z: s.z1 },
        max: { x: s.x2, y: s.y2, z: s.z2 },
      } : null,
      block_count: s.block_count,
      has_blueprint: !!s.blueprint,
      created_at: new Date(s.created_at).toISOString(),
    }))
    return {
      content: [{
        type: 'text',
        text: structures.length === 0
          ? 'No structures built yet.'
          : JSON.stringify(structures, null, 2),
      }],
    }
  }
)

// Tool: query_structure_detail — get details about a specific structure
server.tool(
  'query_structure_detail',
  'Get detailed information about a specific structure by ID: its blueprint, all placed block positions, and what blocks may still be missing. Use after query_structures to inspect a build.',
  { structure_id: z.number().describe('The structure ID from query_structures') },
  async ({ structure_id }) => {
    const structure = stmts.getStructureById.get(structure_id)
    if (!structure) {
      return { content: [{ type: 'text', text: `No structure with id ${structure_id}` }] }
    }

    const placedRows = stmts.getStructureBlocks.all(structure_id)

    // Parse blueprint to determine total expected blocks
    let totalExpected = null
    let missingBlocks = null
    if (structure.blueprint) {
      try {
        const parsed = parseBlueprint(structure.blueprint)
        if (parsed) {
          totalExpected = parsed.blocks.length
          // Determine which blueprint positions have been placed
          const placedSet = new Set(placedRows.map(r =>
            `${r.bp_x},${r.bp_y},${r.bp_z}`
          ))
          missingBlocks = parsed.blocks
            .filter(b => !placedSet.has(`${b.x},${b.y},${b.z}`))
            .map(b => ({
              block: b.block,
              blueprint_offset: { x: b.x, y: b.y, z: b.z },
              world_pos: structure.origin_x != null ? {
                x: structure.origin_x + b.x,
                y: structure.origin_y + b.y,
                z: structure.origin_z + b.z,
              } : null,
            }))
        }
      } catch (e) { /* blueprint parse failed, skip */ }
    }

    // Summarize placed blocks by type (check world state if possible)
    const placedSummary = {}
    for (const r of placedRows) {
      const key = `${r.x},${r.y},${r.z}`
      placedSummary[key] = { x: r.x, y: r.y, z: r.z, bp: { x: r.bp_x, y: r.bp_y, z: r.bp_z } }
    }

    const result = {
      id: structure.id,
      name: structure.name,
      origin: structure.origin_x != null ? { x: structure.origin_x, y: structure.origin_y, z: structure.origin_z } : null,
      created_at: new Date(structure.created_at).toISOString(),
      placed_count: placedRows.length,
      total_expected: totalExpected,
      completion: totalExpected ? `${Math.round(placedRows.length / totalExpected * 100)}%` : 'unknown',
      missing: missingBlocks ? missingBlocks.slice(0, 50) : null, // cap at 50 to avoid huge responses
      missing_count: missingBlocks ? missingBlocks.length : null,
      has_blueprint: !!structure.blueprint,
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  }
)

// Tool: list_biomes — list all explored biomes
server.tool(
  'list_biomes',
  'List all biomes the bot has explored, with section counts and coordinate ranges. Biomes are tracked per 16x16x16 chunk section (Y-aware: deep_dark is underground, plains is surface). Section coords * 16 = block coords.',
  {},
  async () => {
    const rows = stmts.listBiomes.all()
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No biomes explored yet.' }] }
    }
    const biomes = rows.map(r => ({
      biome: r.biome,
      sections_explored: r.section_count,
      block_range: {
        x: { min: r.min_cx * 16, max: r.max_cx * 16 + 15 },
        y: { min: r.min_cy * 16, max: r.max_cy * 16 + 15 },
        z: { min: r.min_cz * 16, max: r.max_cz * 16 + 15 },
      },
    }))
    return { content: [{ type: 'text', text: JSON.stringify(biomes, null, 2) }] }
  }
)

// Tool: locate_biome — find nearest chunks of a specific biome
server.tool(
  'locate_biome',
  'Find the nearest explored chunk sections containing a specific biome. Returns block-level coordinates. Sorted by horizontal (XZ) distance. Includes Y range so you know the depth. Use partial names for fuzzy matching (e.g. "desert", "deep_dark").',
  {
    biome_name: z.string().describe('Biome name or partial name to search for (e.g. "desert", "dark_forest", "deep_dark")'),
    current_chunk_x: z.number().describe('Bot current chunk X (floor(blockX / 16))'),
    current_chunk_z: z.number().describe('Bot current chunk Z (floor(blockZ / 16))'),
    limit: z.number().optional().describe('Max results (default 5)'),
  },
  async ({ biome_name, current_chunk_x, current_chunk_z, limit }) => {
    const maxResults = limit || 5
    const rows = stmts.locateBiome.all(
      `%${biome_name}%`,
      current_chunk_x, current_chunk_x,
      current_chunk_z, current_chunk_z,
      maxResults
    )
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No explored sections with biome matching "${biome_name}". The bot hasn't seen this biome yet — try exploring in a direction.` }] }
    }
    const results = rows.map(r => ({
      chunk: { x: r.chunk_x, y: r.chunk_y, z: r.chunk_z },
      block_center: { x: r.chunk_x * 16 + 8, y: r.chunk_y * 16 + 8, z: r.chunk_z * 16 + 8 },
      distance_blocks: Math.round(Math.sqrt(
        (r.chunk_x - current_chunk_x) ** 2 + (r.chunk_z - current_chunk_z) ** 2
      ) * 16),
    }))
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
  }
)

// Tool: inspect_blocks — query blocks at specific coordinates or in a region from DB
server.tool(
  'inspect_blocks',
  'Query what blocks exist at specific coordinates or in a small region from the bot\'s block memory DB. Use to check what\'s at a location before navigating, or to understand terrain around a point. Only returns blocks the bot has previously seen (via vision raycasting).',
  {
    x: z.number().describe('X coordinate'),
    y: z.number().describe('Y coordinate'),
    z: z.number().describe('Z coordinate'),
    radius: z.number().optional().describe('If set, query a cubic region of this radius around the point (default: single block)'),
  },
  async ({ x, y, z: zCoord, radius }) => {
    if (!radius || radius === 0) {
      // Single block
      const row = stmts.getBlockAt.get(x, y, zCoord)
      if (!row) {
        return { content: [{ type: 'text', text: `No data for (${x},${y},${zCoord}) — bot hasn't seen this block.` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ x, y, z: zCoord, name: row.name, reachable: row.reachable }) }] }
    }
    // Region query
    const r = Math.min(radius, 16) // cap to prevent huge queries
    const rows = stmts.getBlocksInRegion.all(x - r, x + r, y - r, y + r, zCoord - r, zCoord + r, 500)
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No known blocks in region (${x}±${r}, ${y}±${r}, ${zCoord}±${r}).` }] }
    }
    // Summarize by block type
    const summary = {}
    for (const b of rows) {
      summary[b.name] = (summary[b.name] || 0) + 1
    }
    const result = {
      region: { center: { x, y, z: zCoord }, radius: r },
      total_blocks: rows.length,
      summary: Object.entries(summary).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      blocks: rows.slice(0, 100), // first 100 individual blocks
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// Tool: inspect_container — query contents of a specific container by coords
server.tool(
  'inspect_container',
  'Query the contents of a specific container (chest, barrel, furnace, etc.) at given coordinates. Returns item list with counts. Only shows data from the last time the bot opened this container.',
  {
    x: z.number().describe('Container X coordinate'),
    y: z.number().describe('Container Y coordinate'),
    z: z.number().describe('Container Z coordinate'),
  },
  async ({ x, y, z: zCoord }) => {
    try {
      const row = db.prepare(`SELECT type, contents, updated_at FROM containers WHERE x=? AND y=? AND z=?`).get(x, y, zCoord)
      if (!row) {
        return { content: [{ type: 'text', text: `No container data at (${x},${y},${zCoord}) — bot hasn't opened a container there.` }] }
      }
      let contents
      try { contents = JSON.parse(row.contents) } catch (e) { contents = row.contents }
      return { content: [{ type: 'text', text: JSON.stringify({
        type: row.type,
        pos: { x, y, z: zCoord },
        last_checked_tick: row.updated_at,
        contents,
      }, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error querying container: ${e.message}` }] }
    }
  }
)

// Tool: find_items — search blocks, containers, and inventory by multiple partial names
server.tool(
  'find_items',
  `Search for items/blocks across world blocks DB, containers (chests/furnaces/barrels), and bot inventory.
Accepts multiple search terms — each is matched as a substring against item/block names.
Design your search terms to cover what you need. Examples:
- Looking for wood? Use: ["log","planks","stripped"]
- Looking for iron? Use: ["iron"]  (matches iron_ore, iron_ingot, iron_block, iron_nugget, etc.)
- Looking for food? Use: ["bread","cooked","apple","carrot","potato","steak","porkchop"]
- Looking for wool/string? Use: ["wool","string","cobweb"]
Returns results grouped by source (world/containers/inventory) with locations and counts.`,
  {
    search_terms: z.array(z.string()).describe('Array of partial item/block name substrings to match'),
    bot_x: z.number().describe('Bot X position for distance sorting world blocks'),
    bot_y: z.number().describe('Bot Y position'),
    bot_z: z.number().describe('Bot Z position'),
    world_limit: z.number().optional().describe('Max world block results per term (default 10)'),
  },
  async ({ search_terms, bot_x, bot_y, bot_z, world_limit }) => {
    const maxWorld = world_limit || 10
    const result = { world_blocks: [], containers: [], inventory: [] }

    // 1. Search world blocks DB
    for (const term of search_terms) {
      try {
        const stmt = db.prepare(`SELECT x, y, z, name FROM blocks WHERE name LIKE ?
          ORDER BY (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) ASC LIMIT ?`)
        const rows = stmt.all(`%${term}%`, bot_x, bot_x, bot_y, bot_y, bot_z, bot_z, maxWorld)
        for (const r of rows) {
          const dist = Math.round(Math.sqrt((r.x - bot_x) ** 2 + (r.y - bot_y) ** 2 + (r.z - bot_z) ** 2))
          result.world_blocks.push({ name: r.name, x: r.x, y: r.y, z: r.z, distance: dist })
        }
      } catch (e) { console.warn('  [MCP] world search err:', e.message) }
    }
    // Dedupe world blocks by position
    const worldSeen = new Set()
    result.world_blocks = result.world_blocks.filter(b => {
      const k = `${b.x},${b.y},${b.z}`
      if (worldSeen.has(k)) return false
      worldSeen.add(k)
      return true
    }).sort((a, b) => a.distance - b.distance)

    // 2. Search containers
    try {
      const containers = stmts.getAllContainers.all()
      for (const c of containers) {
        let items
        try { items = JSON.parse(c.contents) } catch (e) { continue }
        // Normalize: containers can have items array or input/fuel/output (furnace)
        const allItems = []
        if (Array.isArray(items)) {
          allItems.push(...items)
        } else {
          if (items.input) allItems.push(items.input)
          if (items.fuel) allItems.push(items.fuel)
          if (items.output) allItems.push(items.output)
          if (items.items) allItems.push(...items.items)
        }
        const matched = []
        for (const item of allItems) {
          if (!item?.name) continue
          for (const term of search_terms) {
            if (item.name.includes(term)) {
              matched.push({ name: item.name, count: item.count || 1 })
              break
            }
          }
        }
        if (matched.length > 0) {
          const dist = Math.round(Math.sqrt((c.x - bot_x) ** 2 + (c.y - bot_y) ** 2 + (c.z - bot_z) ** 2))
          result.containers.push({
            type: c.type, x: c.x, y: c.y, z: c.z, distance: dist,
            items: matched,
          })
        }
      }
      result.containers.sort((a, b) => a.distance - b.distance)
    } catch (e) { console.warn('  [MCP] container search err:', e.message) }

    // 3. Search inventory
    try {
      const inv = stmts.getInventory.all()
      for (const item of inv) {
        for (const term of search_terms) {
          if (item.name.includes(term)) {
            result.inventory.push({ name: item.name, count: item.count })
            break
          }
        }
      }
    } catch (e) { console.warn('  [MCP] inventory search err:', e.message) }

    // Summarize
    const totalWorld = result.world_blocks.length
    const totalContainer = result.containers.reduce((s, c) => s + c.items.reduce((s2, i) => s2 + i.count, 0), 0)
    const totalInv = result.inventory.reduce((s, i) => s + i.count, 0)

    if (totalWorld === 0 && totalContainer === 0 && totalInv === 0) {
      return { content: [{ type: 'text', text: `No matches for search terms: ${search_terms.join(', ')}` }] }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: `${totalWorld} world blocks, ${totalContainer} items in containers, ${totalInv} items in inventory`,
          ...result,
        }, null, 2),
      }],
    }
  }
)

// Helper: format chat log rows with in-game time
function formatChatRows(rows) {
  return rows.map(r => ({
    game_time: gameTimeString(r.game_tick, r.game_day),
    tick: r.game_tick,
    type: r.type,
    who: r.username || '',
    message: r.message,
  }))
}

// Tool: query_chat_log — get recent chat history
server.tool(
  'query_chat_log',
  'Get recent chat history (player messages, bot replies, game events like joins/deaths/advancements). Times shown as in-game day and time (day0 06:00 = world start). Use since_tick with bot.time.age to get events from a specific point.',
  {
    limit: z.number().optional().describe('Max entries to return (default 30)'),
    username: z.string().optional().describe('Filter by username (exact match)'),
    since_tick: z.number().optional().describe('Only show entries after this game tick (use bot.time.age from context)'),
  },
  async ({ limit, username, since_tick }) => {
    const max = limit || 30
    let rows
    if (username) {
      rows = stmts.chatByUser.all(username, max)
    } else if (since_tick != null) {
      rows = stmts.chatSinceTick.all(since_tick, max)
    } else {
      rows = stmts.recentChat.all(max)
    }
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No chat history found.' }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(formatChatRows(rows), null, 2) }] }
  }
)

// Tool: search_chat_log — search chat history by keyword
server.tool(
  'search_chat_log',
  'Search chat history for messages containing a keyword or phrase. Searches across player chat, bot replies, and game events (deaths, advancements, joins/leaves). Use to find when something was discussed, who said what, or when an event happened.',
  {
    query: z.string().describe('Search term (substring match, case-insensitive in SQLite default)'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ query, limit }) => {
    const max = limit || 20
    const rows = stmts.searchChat.all(`%${query}%`, max)
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No chat messages matching "${query}".` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(formatChatRows(rows), null, 2) }] }
  }
)

// Helper: format event rows
function formatEventRows(rows) {
  return rows.map(r => {
    const entry = {
      game_time: gameTimeString(r.game_tick, r.game_day), tick: r.game_tick, type: r.type,
      target: r.target, count: r.count,
    }
    if (r.x != null) entry.pos = { x: r.x, y: r.y, z: r.z }
    if (r.detail) try { entry.detail = JSON.parse(r.detail) } catch (e) {}
    return entry
  })
}

// Tool: search_events — search all events by target name pattern
server.tool(
  'search_events',
  `Search game events by item/block/entity name across ALL event types (mine, place, kill, craft, smelt, pickup, drop, give, deposit, withdraw, death, eat, equip). Use to find everything that happened involving a specific thing. Example: search "diamond" to see diamonds mined, crafted, deposited, given, etc.`,
  {
    target_pattern: z.string().describe('Item/block/entity name substring (e.g. "diamond", "iron", "zombie")'),
    type: z.string().optional().describe('Filter by event type (mine, place, kill, craft, smelt, pickup, drop, give, deposit, withdraw, death, eat, equip)'),
    limit: z.number().optional().describe('Max results (default 30)'),
  },
  async ({ target_pattern, type, limit }) => {
    const max = limit || 30
    const rows = type
      ? stmts.searchEventsTyped.all(`%${target_pattern}%`, type, max)
      : stmts.searchEvents.all(`%${target_pattern}%`, max)
    if (rows.length === 0) return { content: [{ type: 'text', text: `No events matching "${target_pattern}"${type ? ` (type=${type})` : ''}.` }] }
    return { content: [{ type: 'text', text: JSON.stringify(formatEventRows(rows), null, 2) }] }
  }
)

// Tool: recent_events — get latest events
server.tool(
  'recent_events',
  'Get the most recent game events. Optionally filter by type. Use to see what just happened.',
  {
    type: z.string().optional().describe('Filter by event type'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ type, limit }) => {
    const max = limit || 20
    const rows = type
      ? stmts.recentEventsByType.all(type, max)
      : stmts.recentEvents.all(max)
    if (rows.length === 0) return { content: [{ type: 'text', text: 'No events recorded yet.' }] }
    return { content: [{ type: 'text', text: JSON.stringify(formatEventRows(rows), null, 2) }] }
  }
)

// Tool: event_stats — aggregated event statistics
server.tool(
  'event_stats',
  'Get aggregated statistics: total blocks mined by type, mobs killed, items crafted, etc. Optionally filter by event type.',
  {
    type: z.string().optional().describe('Filter by event type (e.g. "mine", "kill", "craft")'),
  },
  async ({ type }) => {
    const rows = type
      ? stmts.eventStatsType.all(type)
      : stmts.eventStats.all()
    if (rows.length === 0) return { content: [{ type: 'text', text: 'No events recorded yet.' }] }
    const result = rows.map(r => ({
      ...(r.type ? { type: r.type } : {}),
      target: r.target, total: r.total, times: r.times,
    }))
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// Tool: events_near — spatial event query
server.tool(
  'events_near',
  'Find events that happened near specific coordinates. Use to see what was mined/placed/killed in an area.',
  {
    x: z.number().describe('Center X coordinate'),
    y: z.number().describe('Center Y coordinate'),
    z: z.number().describe('Center Z coordinate'),
    radius: z.number().optional().describe('Search radius in blocks (default 16)'),
    type: z.string().optional().describe('Filter by event type'),
    limit: z.number().optional().describe('Max results (default 30)'),
  },
  async ({ x, y, z: zCoord, radius, type, limit }) => {
    const r = radius || 16
    const max = limit || 30
    let rows = stmts.eventsNear.all(x, x, y, y, zCoord, zCoord, r * r, max)
    if (type) rows = rows.filter(row => row.type === type)
    if (rows.length === 0) return { content: [{ type: 'text', text: `No events within ${r} blocks of ${x},${y},${zCoord}.` }] }
    return { content: [{ type: 'text', text: JSON.stringify(formatEventRows(rows), null, 2) }] }
  }
)

// Tool: query_task_history — task stack changes over time
server.tool(
  'query_task_history',
  'Get history of task stack changes (push, pop, replace, clear, auto-pop) with game time. Shows what tasks were active, when they changed, and why. Use to recall what you were working on or why a task was abandoned.',
  {
    limit: z.number().optional().describe('Max entries (default 20)'),
    search: z.string().optional().describe('Search term to filter tasks by name/detail'),
  },
  async ({ limit, search }) => {
    const max = limit || 20
    let rows
    if (search) {
      const pat = `%${search}%`
      rows = stmts.searchTasks.all(pat, pat, pat, max)
    } else {
      rows = stmts.recentTasks.all(max)
    }
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No task history found.' }] }
    }
    const entries = rows.map(r => {
      const entry = {
        game_time: gameTimeString(r.game_tick, r.game_day),
        action: r.action,
        task: r.task,
        stack_after: r.stack_after,
      }
      if (r.detail) try { entry.detail = JSON.parse(r.detail) } catch (e) { entry.detail = r.detail }
      return entry
    })
    return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] }
  }
)

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('MCP server: started\n')
}

main().catch(e => {
  process.stderr.write(`MCP server fatal: ${e.message}\n`)
  process.exit(1)
})
