// SQLite spatial memory — stores every block ever seen, structures, utility blocks
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const Database = require('better-sqlite3')
const state = require('../core/state')

// Helper: get current game tick (world age). Returns 0 if bot not connected yet.
function gameTick() { return state.bot?.time?.age || 0 }
function gameDay() { return state.bot?.time?.day || 0 }
// The dimension the bot is in now ('overworld', 'the_nether', 'the_end'), keying
// every spatial row. Before login there is no bot; assume the overworld.
function currentDim() { return (state.bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '') }

function initDB() {
  const DB_PATH = path.join(state.BOT_DATA_DIR, 'blocks.db')
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  // Every coordinate belongs to a dimension: the Nether and the overworld share
  // x,y,z ranges, so spatial rows carry `dim` and every spatial statement filters
  // on cur_dim() — the dimension the bot is in now. Callers never pass it.
  db.function('cur_dim', { deterministic: false }, currentDim)

  // Migration: coordinate-keyed tables gain `dim` in their primary key. SQLite
  // can't alter a PK, so a pre-dim table is renamed aside, recreated below and
  // refilled; old rows are assumed overworld.
  const DIM_TABLES = ['blocks', 'placed_blocks', 'containers', 'path_blocks', 'chunk_biomes']
  const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)
  const toRefill = []
  for (const t of DIM_TABLES) {
    const cols = colsOf(t)
    if (cols.length > 0 && !cols.includes('dim')) {
      db.exec(`ALTER TABLE ${t} RENAME TO ${t}_predim`)
      toRefill.push([t, cols])
    }
  }
  // Indexes follow a renamed table, so drop them or CREATE INDEX IF NOT EXISTS
  // below would see the name taken and skip the new table.
  for (const [t] of toRefill) {
    for (const ix of db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(`${t}_predim`)) {
      db.exec(`DROP INDEX ${ix.name}`)
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      dim TEXT NOT NULL,
      x INTEGER, y INTEGER, z INTEGER,
      name TEXT NOT NULL, seen_at INTEGER NOT NULL,
      reachable TEXT DEFAULT 'unknown',
      PRIMARY KEY (dim, x, y, z)
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_name ON blocks(dim, name);
    CREATE TABLE IF NOT EXISTS placed_blocks (
      dim TEXT NOT NULL,
      x INTEGER, y INTEGER, z INTEGER,
      structure_id INTEGER,
      bp_x INTEGER, bp_y INTEGER, bp_z INTEGER,
      PRIMARY KEY (dim, x, y, z)
    );
    CREATE TABLE IF NOT EXISTS structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      blueprint TEXT,
      origin_x INTEGER, origin_y INTEGER, origin_z INTEGER,
      dim TEXT NOT NULL DEFAULT 'overworld'
    );
    CREATE TABLE IF NOT EXISTS containers (
      dim TEXT NOT NULL,
      x INTEGER, y INTEGER, z INTEGER,
      type TEXT NOT NULL,
      contents TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (dim, x, y, z)
    );
    CREATE TABLE IF NOT EXISTS path_blocks (
      dim TEXT NOT NULL,
      x INTEGER, y INTEGER, z INTEGER,
      path_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (dim, x, y, z)
    );
    CREATE TABLE IF NOT EXISTS chunk_biomes (
      dim TEXT NOT NULL,
      chunk_x INTEGER, chunk_y INTEGER, chunk_z INTEGER,
      biome TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (dim, chunk_x, chunk_y, chunk_z, biome)
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_biomes_biome ON chunk_biomes(dim, biome);
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_tick INTEGER NOT NULL,
      game_day INTEGER NOT NULL,
      type TEXT NOT NULL,
      username TEXT,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_log_tick ON chat_log(game_tick);
    CREATE INDEX IF NOT EXISTS idx_chat_log_type ON chat_log(type);
    CREATE INDEX IF NOT EXISTS idx_chat_log_user ON chat_log(username);
    CREATE TABLE IF NOT EXISTS task_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_tick INTEGER NOT NULL,
      game_day INTEGER NOT NULL,
      action TEXT NOT NULL,
      task TEXT,
      detail TEXT,
      stack_after TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_log_tick ON task_log(game_tick);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_tick INTEGER NOT NULL,
      game_day INTEGER NOT NULL,
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      x INTEGER, y INTEGER, z INTEGER,
      detail TEXT,
      dim TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_tick ON events(game_tick);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
    CREATE INDEX IF NOT EXISTS idx_events_type_target ON events(type, target);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `)

  // Migrations
  const addColIfMissing = (table, col, type) => {
    try { db.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).get() }
    catch (e) { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); return true }
    return false
  }
  let migrated = false
  if (addColIfMissing('placed_blocks', 'structure_id', 'INTEGER')) migrated = true
  if (addColIfMissing('placed_blocks', 'bp_x', 'INTEGER')) migrated = true
  if (addColIfMissing('placed_blocks', 'bp_y', 'INTEGER')) migrated = true
  if (addColIfMissing('placed_blocks', 'bp_z', 'INTEGER')) migrated = true
  if (addColIfMissing('structures', 'blueprint', 'TEXT')) migrated = true
  if (addColIfMissing('structures', 'origin_x', 'INTEGER')) migrated = true
  if (addColIfMissing('structures', 'origin_y', 'INTEGER')) migrated = true
  if (addColIfMissing('structures', 'origin_z', 'INTEGER')) migrated = true
  if (addColIfMissing('blocks', 'reachable', "TEXT DEFAULT 'unknown'")) migrated = true
  // The block's protocol state id: its properties (a frame's eye, a door's open/half,
  // a slab's type). NULL = not known, e.g. rows written before this column existed.
  if (addColIfMissing('blocks', 'state', 'INTEGER')) migrated = true
  if (addColIfMissing('structures', 'dim', "TEXT NOT NULL DEFAULT 'overworld'")) migrated = true
  if (addColIfMissing('events', 'dim', 'TEXT')) {
    db.exec(`UPDATE events SET dim = 'overworld' WHERE x IS NOT NULL`)
    migrated = true
  }
  for (const [t, cols] of toRefill) {
    const keep = cols.filter(c => colsOf(t).includes(c)).join(', ')
    db.exec(`INSERT INTO ${t} (dim, ${keep}) SELECT 'overworld', ${keep} FROM ${t}_predim; DROP TABLE ${t}_predim`)
    console.log(`  [MEMORY] ${t}: added dim (old rows → overworld)`)
    migrated = true
  }
  if (migrated) console.log('  [MEMORY] DB schema migrated')
  db.exec('CREATE INDEX IF NOT EXISTS idx_placed_structure ON placed_blocks(structure_id)')

  // Prepared statements
  const stmts = {
    upsertBlock: db.prepare(`INSERT INTO blocks (dim,x,y,z,name,seen_at,state) VALUES (cur_dim(),?,?,?,?,?,?)
      ON CONFLICT(dim,x,y,z) DO UPDATE SET name=excluded.name, seen_at=excluded.seen_at, state=excluded.state`),
    removeBlock: db.prepare(`DELETE FROM blocks WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    queryByName: db.prepare(`SELECT x,y,z,name,seen_at FROM blocks WHERE dim=cur_dim() AND name=?
      ORDER BY (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) ASC LIMIT ?`),
    isPlaced: db.prepare(`SELECT 1 FROM placed_blocks WHERE dim=cur_dim() AND x=? AND y=? AND z=? AND structure_id IS NOT NULL`),
    addPlaced: db.prepare(`INSERT OR IGNORE INTO placed_blocks (dim,x,y,z,structure_id,bp_x,bp_y,bp_z) VALUES (cur_dim(),?,?,?,?,?,?,?)`),
    removePlaced: db.prepare(`DELETE FROM placed_blocks WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    createStructure: db.prepare(`INSERT INTO structures (dim, name, created_at, blueprint, origin_x, origin_y, origin_z) VALUES (cur_dim(), ?, ?, ?, ?, ?, ?)`),
    getStructures: db.prepare(`SELECT s.id, s.name, s.created_at,
      MIN(p.x) as x1, MAX(p.x) as x2, MIN(p.y) as y1, MAX(p.y) as y2, MIN(p.z) as z1, MAX(p.z) as z2,
      COUNT(p.x) as block_count
      FROM structures s LEFT JOIN placed_blocks p ON p.structure_id = s.id
      WHERE s.dim = cur_dim() GROUP BY s.id ORDER BY s.created_at DESC`),
    tagBlock: db.prepare(`UPDATE placed_blocks SET structure_id=? WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    blockStructure: db.prepare(`SELECT s.name FROM placed_blocks p JOIN structures s ON p.structure_id = s.id WHERE p.dim=cur_dim() AND p.x=? AND p.y=? AND p.z=?`),
    upsertContainer: db.prepare(`INSERT INTO containers (dim,x,y,z,type,contents,updated_at) VALUES (cur_dim(),?,?,?,?,?,?)
      ON CONFLICT(dim,x,y,z) DO UPDATE SET type=excluded.type, contents=excluded.contents, updated_at=excluded.updated_at`),
    getContainer: db.prepare(`SELECT type, contents, updated_at FROM containers WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    removeContainer: db.prepare(`DELETE FROM containers WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    getNearbyContainers: db.prepare(`SELECT x,y,z,type,contents,updated_at FROM containers
      WHERE dim=cur_dim() AND (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) < ? ORDER BY (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) ASC LIMIT 20`),
    queryByNameLike: db.prepare(`SELECT x,y,z,name,seen_at FROM blocks WHERE dim=cur_dim() AND name LIKE ?
      ORDER BY (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) ASC LIMIT ?`),
    queryUtilBlocks: db.prepare(`SELECT x,y,z,name FROM blocks WHERE dim=cur_dim() AND name IN ('furnace','crafting_table','chest','trapped_chest','barrel','anvil','smoker','blast_furnace','enchanting_table','brewing_stand')
      ORDER BY (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) ASC LIMIT ?`),
    getBlockAt: db.prepare(`SELECT name, reachable, state FROM blocks WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    upsertBlockReach: db.prepare(`INSERT INTO blocks (dim,x,y,z,name,seen_at,reachable,state) VALUES (cur_dim(),?,?,?,?,?,?,?)
      ON CONFLICT(dim,x,y,z) DO UPDATE SET
        name=excluded.name, seen_at=excluded.seen_at, state=excluded.state,
        reachable = CASE
          WHEN blocks.name != excluded.name THEN excluded.reachable
          WHEN blocks.reachable = 'yes' THEN 'yes'
          ELSE excluded.reachable
        END`),
    // Region query (bounding box)
    queryRegion: db.prepare(`SELECT x, y, z, name, state FROM blocks
      WHERE dim=cur_dim() AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ?`),
    // Path blocks
    addPathBlock: db.prepare(`INSERT OR REPLACE INTO path_blocks (dim,x,y,z,path_type,created_at) VALUES (cur_dim(),?,?,?,?,?)`),
    isPathBlock: db.prepare(`SELECT 1 FROM path_blocks WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    removePathBlock: db.prepare(`DELETE FROM path_blocks WHERE dim=cur_dim() AND x=? AND y=? AND z=?`),
    countPathBlocksNear: db.prepare(`SELECT COUNT(*) as c FROM path_blocks
      WHERE dim=cur_dim() AND (x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?) < ?`),
    clearOldPathBlocks: db.prepare(`DELETE FROM path_blocks WHERE created_at < ?`),
    // Chunk biomes
    upsertChunkBiome: db.prepare(`INSERT INTO chunk_biomes (dim, chunk_x, chunk_y, chunk_z, biome, seen_at) VALUES (cur_dim(), ?, ?, ?, ?, ?)
      ON CONFLICT(dim, chunk_x, chunk_y, chunk_z, biome) DO UPDATE SET seen_at=excluded.seen_at`),
    // Chat log
    insertChatLog: db.prepare(`INSERT INTO chat_log (game_tick, game_day, type, username, message) VALUES (?, ?, ?, ?, ?)`),
    // Task log
    insertTaskLog: db.prepare(`INSERT INTO task_log (game_tick, game_day, action, task, detail, stack_after) VALUES (?, ?, ?, ?, ?, ?)`),
    // Events
    insertEvent: db.prepare(`INSERT INTO events (game_tick, game_day, type, target, count, dim, x, y, z, detail) VALUES (?, ?, ?, ?, ?, cur_dim(), ?, ?, ?, ?)`),
  }

  const upsertBatch = db.transaction((blocks) => {
    const now = gameTick()
    for (const b of blocks) stmts.upsertBlock.run(b.x, b.y, b.z, b.name, now, b.state ?? null)
  })

  const upsertBatchReach = db.transaction((blocks) => {
    const now = gameTick()
    for (const b of blocks) stmts.upsertBlockReach.run(b.x, b.y, b.z, b.name, now, b.reachable || 'unknown', b.state ?? null)
  })

  state.db = db
  state.stmts = stmts
  state.stmts.upsertBatch = upsertBatch
  state.stmts.upsertBatchReach = upsertBatchReach

  // One-time migration from JSON files to SQLite
  try {
    const MEMORY_FILE = path.join(state.BOT_DATA_DIR, 'block-memory.json')
    const PLACED_FILE = path.join(state.BOT_DATA_DIR, 'placed-blocks.json')
    if (fs.existsSync(MEMORY_FILE)) {
      const blockMemory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'))
      const allBlocks = []
      for (const [name, entries] of Object.entries(blockMemory)) {
        for (const e of entries) allBlocks.push({ x: e.x, y: e.y, z: e.z, name })
      }
      if (allBlocks.length > 0) {
        upsertBatch(allBlocks)
        console.log(`  [MEMORY] migrated ${allBlocks.length} blocks from JSON to SQLite`)
      }
      fs.renameSync(MEMORY_FILE, MEMORY_FILE + '.bak')
    }
    if (fs.existsSync(PLACED_FILE)) {
      const arr = JSON.parse(fs.readFileSync(PLACED_FILE, 'utf-8'))
      const insertPlaced = db.transaction((keys) => {
        for (const key of keys) {
          const [x, y, z] = key.split(',').map(Number)
          if (!isNaN(x) && !isNaN(y) && !isNaN(z)) stmts.addPlaced.run(x, y, z, null, null, null, null)
        }
      })
      insertPlaced(arr)
      if (arr.length > 0) console.log(`  [MEMORY] migrated ${arr.length} placed blocks from JSON to SQLite`)
      fs.renameSync(PLACED_FILE, PLACED_FILE + '.bak')
    }
  } catch (e) { console.log('  [MEMORY] JSON migration skipped:', e.message) }

  // Log DB stats
  try {
    const blockCount = db.prepare('SELECT COUNT(*) as c FROM blocks').get().c
    const placedCount = db.prepare('SELECT COUNT(*) as c FROM placed_blocks').get().c
    const structCount = db.prepare('SELECT COUNT(*) as c FROM structures').get().c
    if (blockCount > 0 || placedCount > 0) {
      console.log(`  [MEMORY] SQLite loaded: ${blockCount} blocks, ${placedCount} placed, ${structCount} structures`)
    }
  } catch (e) { console.warn('  [MEMORY] DB stats query err:', e.message) }
}

const { PASSABLE } = require('../config/blocks')
const { SEARCH_NEARBY, SEARCH_STANDARD } = require('../config/search')

// updateBlockMemory removed (was identical to updateBlockMemoryReach, never called)

function updateBlockMemoryReach(visionResult) {
  if (!visionResult?.allBlocks || visionResult.allBlocks.length === 0) return
  const bot = state.bot
  const pos = bot?.entity?.position
  if (!pos) return
  const filtered = visionResult.allBlocks.filter(b => {
    if (!PASSABLE.has(b.name)) return true
    // Passable/air blocks within the nearby radius (for pathfinding corridor data)
    return Math.abs(b.x - pos.x) <= SEARCH_NEARBY && Math.abs(b.y - pos.y) <= SEARCH_NEARBY && Math.abs(b.z - pos.z) <= SEARCH_NEARBY
  })
  if (filtered.length > 0) {
    try { state.stmts.upsertBatchReach(filtered) } catch (e) { console.log(`  [MEMORY] upsert err: ${e.message}`) }
  }
}

// Async chunked upsert — breaks large vision results into small batches
// with setImmediate yields between each to avoid blocking the event loop.
async function upsertVisionChunked(visionResult, chunkSize = 200) {
  if (!visionResult?.allBlocks || visionResult.allBlocks.length === 0) return
  const bot = state.bot
  const pos = bot?.entity?.position
  if (!pos) return
  const filtered = visionResult.allBlocks.filter(b => {
    if (!PASSABLE.has(b.name)) return true
    return Math.abs(b.x - pos.x) <= SEARCH_NEARBY && Math.abs(b.y - pos.y) <= SEARCH_NEARBY && Math.abs(b.z - pos.z) <= SEARCH_NEARBY
  })
  if (filtered.length === 0) return
  const now = gameTick()
  for (let i = 0; i < filtered.length; i += chunkSize) {
    const chunk = filtered.slice(i, i + chunkSize)
    try {
      state.db.transaction(() => {
        for (const b of chunk) {
          state.stmts.upsertBlockReach.run(b.x, b.y, b.z, b.name, now, b.reachable || 'unknown', b.state ?? null)
        }
      })()
    } catch (e) { console.warn('  [MEMORY] block upsert chunk err:', e.message) }
    // Yield to event loop between chunks
    if (i + chunkSize < filtered.length) {
      await new Promise(r => setImmediate(r))
    }
  }
}

function queryBlockMemory(matchingNames, botPos) {
  const results = []
  for (const name of matchingNames) {
    try {
      const rows = state.stmts.queryByName.all(name, botPos.x, botPos.x, botPos.y, botPos.y, botPos.z, botPos.z, 50)
      for (const r of rows) {
        if (state.stmts.isPlaced.get(r.x, r.y, r.z)) continue
        const dist = botPos.distanceTo(new Vec3(r.x, r.y, r.z))
        const age = Math.round((gameTick() - r.seen_at) / 20) // seconds since last seen
        results.push({ x: r.x, y: r.y, z: r.z, name: r.name, dist, age })
      }
    } catch (e) { console.warn('  [MEMORY] queryBlockMemory err:', e.message) }
  }
  results.sort((a, b) => a.dist - b.dist)
  return results
}

function queryBlockMemoryFuzzy(partialName, botPos, limit = 10) {
  const results = []
  try {
    const rows = state.stmts.queryByNameLike.all(
      `%${partialName}%`, botPos.x, botPos.x, botPos.y, botPos.y, botPos.z, botPos.z, limit * 2
    )
    for (const r of rows) {
      if (state.stmts.isPlaced.get(r.x, r.y, r.z)) continue
      const dist = botPos.distanceTo(new Vec3(r.x, r.y, r.z))
      results.push({ x: r.x, y: r.y, z: r.z, name: r.name, dist })
    }
  } catch (e) { console.warn('  [MEMORY] queryBlockMemoryFuzzy err:', e.message) }
  results.sort((a, b) => a.dist - b.dist)
  return results.slice(0, limit)
}

function searchContainersFor(partialName, botPos, radius = 128) {
  const containers = getNearbyContainers(botPos, radius)
  const results = []
  for (const c of containers) {
    const dist = botPos.distanceTo(new Vec3(c.x, c.y, c.z))
    // Furnace-style containers
    for (const slot of ['input', 'fuel', 'output']) {
      if (c.contents[slot] && c.contents[slot].name.includes(partialName)) {
        results.push({ x: c.x, y: c.y, z: c.z, type: c.type, itemName: c.contents[slot].name, count: c.contents[slot].count, dist })
      }
    }
    // Chest/barrel items array
    if (c.contents.items) {
      for (const item of c.contents.items) {
        if (item.name.includes(partialName)) {
          results.push({ x: c.x, y: c.y, z: c.z, type: c.type, itemName: item.name, count: item.count, dist })
        }
      }
    }
  }
  results.sort((a, b) => a.dist - b.dist)
  return results
}

function trackPlacedBlock(x, y, z, structureId = null, bpX = null, bpY = null, bpZ = null) {
  try { state.stmts.addPlaced.run(Math.floor(x), Math.floor(y), Math.floor(z), structureId, bpX, bpY, bpZ) } catch (e) { console.log(`  [MEMORY] trackPlaced err: ${e.message}`) }
}

function createStructure(name, blueprint = null, originX = null, originY = null, originZ = null) {
  try {
    const result = state.stmts.createStructure.run(name, gameTick(), blueprint, originX, originY, originZ)
    console.log(`  [STRUCT] created "${name}" (id=${result.lastInsertRowid})`)
    return result.lastInsertRowid
  } catch (e) { console.log(`  [MEMORY] createStructure err: ${e.message}`); return null }
}

function getStructures() {
  try { return state.stmts.getStructures.all() } catch (e) { return [] }
}

function removeBlock(x, y, z) {
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z)
  try { state.stmts.removeBlock.run(bx, by, bz) } catch (e) { console.warn('  [MEMORY] removeBlock err:', e.message) }
  try { state.stmts.removePlaced.run(bx, by, bz) } catch (e) { console.warn('  [MEMORY] removePlaced err:', e.message) }
}

// --- Utility block queries (from DB, replaces old knownUtils JSON file) ---
function queryUtilityBlocks(botPos, limit = 20) {
  try {
    return state.stmts.queryUtilBlocks.all(botPos.x, botPos.x, botPos.y, botPos.y, botPos.z, botPos.z, limit)
  } catch (e) { return [] }
}

// registerUtil/removeUtil/loadUtils/verifyUtils removed — utility blocks tracked via blocks table

// --- Container state ---
function saveContainerState(x, y, z, type, contents) {
  try {
    const json = JSON.stringify(contents)
    state.stmts.upsertContainer.run(x, y, z, type, json, gameTick())
    console.log(`  [CONTAINER] saved ${type} at ${x},${y},${z}: ${json.length > 80 ? json.slice(0, 77) + '...' : json}`)
  } catch (e) { console.error('  [CONTAINER] save error:', e.message) }
}

function getContainerState(x, y, z) {
  try {
    const row = state.stmts.getContainer.get(x, y, z)
    if (!row) return null
    return { type: row.type, contents: JSON.parse(row.contents), updatedAt: row.updated_at }
  } catch (e) { return null }
}

function removeContainerState(x, y, z) {
  try { state.stmts.removeContainer.run(x, y, z) } catch (e) { console.warn('  [MEMORY] removeContainer err:', e.message) }
}

function getNearbyContainers(botPos, radius) {
  try {
    const r2 = radius * radius
    return state.stmts.getNearbyContainers.all(
      botPos.x, botPos.x, botPos.y, botPos.y, botPos.z, botPos.z, r2,
      botPos.x, botPos.x, botPos.y, botPos.y, botPos.z, botPos.z
    ).map(r => ({
      x: r.x, y: r.y, z: r.z, type: r.type,
      contents: JSON.parse(r.contents), updatedAt: r.updated_at
    }))
  } catch (e) { return [] }
}

// --- Block state ---
// State ids are numbered per game version (26.1 and 26.3 differ), so a stored one
// only means something under the version that wrote it. Called on spawn, once the
// version is known: joining under another version forgets every stored state.
function checkStateVersion(version) {
  try {
    const row = state.db.prepare(`SELECT value FROM meta WHERE key='state_version'`).get()
    if (row?.value === version) return
    if (row) {
      const n = state.db.prepare('UPDATE blocks SET state=NULL WHERE state IS NOT NULL').run().changes
      console.log(`  [MEMORY] game version ${row.value} → ${version}: forgot ${n} block states`)
    }
    state.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('state_version', ?)`).run(version)
  } catch (e) { console.warn('  [MEMORY] state version check err:', e.message) }
}

// A stored state id → the block's properties ({ eye: true, facing: 'north' }), or
// null when it isn't known. One decode per id per registry.
let _propsReg = null
const _propsCache = new Map()
function stateProps(id) {
  const reg = state.bot?.registry
  if (id === null || id === undefined || !reg) return null
  if (reg !== _propsReg) { _propsReg = reg; _propsCache.clear() }
  let p = _propsCache.get(id)
  if (!p) {
    try { p = require('prismarine-block')(reg).fromStateId(id, 0).getProperties() } catch (e) { return null }
    _propsCache.set(id, p)
  }
  return p
}

// --- Region query ---
function queryRegion(x1, y1, z1, x2, y2, z2) {
  try {
    return state.stmts.queryRegion.all(
      Math.min(x1, x2), Math.max(x1, x2),
      Math.min(y1, y2), Math.max(y1, y2),
      Math.min(z1, z2), Math.max(z1, z2)
    )
  } catch (e) { return [] }
}

// --- Path blocks ---
function trackPathBlock(x, y, z, pathType) {
  try { state.stmts.addPathBlock.run(x, y, z, pathType, gameTick()) } catch (e) { console.warn('  [MEMORY] addPathBlock err:', e.message) }
}

function isPathBlock(x, y, z) {
  try { return !!state.stmts.isPathBlock.get(x, y, z) } catch (e) { return false }
}

function clearOldPathBlocks(maxAgeTicks = 36000) { // 30 min at 20 ticks/sec
  try {
    const cutoff = gameTick() - maxAgeTicks
    const result = state.stmts.clearOldPathBlocks.run(cutoff)
    if (result.changes > 0) console.log(`  [PATH] cleared ${result.changes} old path blocks`)
  } catch (e) { console.warn('  [MEMORY] clearOldPathBlocks err:', e.message) }
}

function countNearbyPathBlocks(pos, radius = SEARCH_STANDARD) {
  try {
    const r2 = radius * radius
    return state.stmts.countPathBlocksNear.get(pos.x, pos.x, pos.y, pos.y, pos.z, pos.z, r2)?.c || 0
  } catch (e) { return 0 }
}

// --- Chunk biome tracking ---
// Samples biomes from vision blocks and records per chunk section.
// Chunk section coords: cx = floor(blockX/16), cy = floor(blockY/16), cz = floor(blockZ/16).
// A single chunk column can have different biomes at different Y levels (e.g. deep_dark below, plains above).
function updateChunkBiomes(visionResult) {
  if (!visionResult?.allBlocks || visionResult.allBlocks.length === 0) return
  const bot = state.bot
  if (!bot?.entity) return
  const mcData = require('minecraft-data')(bot.version)
  if (!mcData?.biomes) return

  // Collect unique chunk section coords from vision blocks, sample biome at each
  const seen = new Set()
  const entries = []
  for (const b of visionResult.allBlocks) {
    const cx = Math.floor(b.x / 16)
    const cy = Math.floor(b.y / 16)
    const cz = Math.floor(b.z / 16)
    const key = `${cx},${cy},${cz}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const block = bot.blockAt(new Vec3(b.x, b.y, b.z))
      if (block?.biome) {
        const info = mcData.biomes[block.biome.id]
        if (info) entries.push({ cx, cy, cz, biome: info.name })
      }
    } catch (e) { /* blockAt may fail for unloaded chunks */ }
  }

  // Also always record the bot's own chunk section
  try {
    const pos = bot.entity.position
    const bcx = Math.floor(pos.x / 16)
    const bcy = Math.floor(pos.y / 16)
    const bcz = Math.floor(pos.z / 16)
    const bkey = `${bcx},${bcy},${bcz}`
    if (!seen.has(bkey)) {
      const block = bot.blockAt(pos.offset(0, -1, 0))
      if (block?.biome) {
        const info = mcData.biomes[block.biome.id]
        if (info) entries.push({ cx: bcx, cy: bcy, cz: bcz, biome: info.name })
      }
    }
  } catch (e) { console.warn('  [MEMORY] bot chunk biome err:', e.message) }

  if (entries.length === 0) return
  try {
    const now = gameTick()
    const batch = state.db.transaction((items) => {
      for (const e of items) state.stmts.upsertChunkBiome.run(e.cx, e.cy, e.cz, e.biome, now)
    })
    batch(entries)
  } catch (e) { console.warn('  [MEMORY] biome upsert err:', e.message) }
}

// --- Chat log to DB ---
// type: 'chat' (player), 'bot' (bot reply), 'event' (join/leave/death/advancement)
function logChatDB(type, username, message) {
  const bot = state.bot
  const tick = bot?.time?.age || 0
  const day = bot?.time?.day || 0
  try { state.stmts.insertChatLog.run(tick, day, type, username || null, message) } catch (e) { console.log(`  [MEMORY] chatLog err: ${e.message}`) }
}

// --- Task stack logging ---
// action: 'push', 'pop', 'replace', 'clear'
function logTaskAction(action, task, detail, stackAfter) {
  try {
    state.stmts.insertTaskLog.run(gameTick(), gameDay(), action, task || null, detail || null, stackAfter || null)
  } catch (e) { console.warn('  [MEMORY] taskLog err:', e.message) }
}

// --- Game events ---
// Unified logging for all atomic game actions.
// type: mine, place, kill, craft, smelt, pickup, drop, give, eat, equip, deposit, withdraw, death
// detail: JSON object with type-specific fields (tool, reason, weapon, consumed, etc.)
function logGameEvent(type, target, count, x, y, z, detail) {
  try {
    const d = detail ? JSON.stringify(detail) : null
    state.stmts.insertEvent.run(gameTick(), gameDay(), type, target, count || 1, x ?? null, y ?? null, z ?? null, d)
  } catch (e) { console.log(`  [MEMORY] event err: ${e.message}`) }
}

module.exports = {
  initDB, currentDim, updateBlockMemoryReach, queryBlockMemory, queryBlockMemoryFuzzy,
  trackPlacedBlock, createStructure, getStructures, removeBlock, queryUtilityBlocks,
  saveContainerState, getContainerState, removeContainerState, getNearbyContainers, searchContainersFor,
  queryRegion, checkStateVersion, stateProps,
  trackPathBlock, isPathBlock, clearOldPathBlocks, countNearbyPathBlocks,
  updateChunkBiomes, logChatDB, logGameEvent, logTaskAction, upsertVisionChunked,
}
