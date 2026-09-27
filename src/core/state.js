// Shared mutable state singleton — all modules import this
module.exports = {
  bot: null,
  // Action state
  currentTask: null,
  navigationStatus: null,
  actionQueue: [],
  backgroundTask: null,
  // Abort/interrupt
  abortSignal: false,
  interrupted: false,
  // Intervals
  followTarget: null,
  followInterval: null,
  activeSailTick: null,
  // AI state
  apiFailCount: 0,
  lastModelCheck: Date.now(),
  msgPending: false,
  noActionRounds: 0,
  aiPaused: false,       // debug `!ai off`: engine makes no model calls
  idleAnnounced: false,  // true once the model has reported going idle; gates idle self-checks

  messageQueue: [],
  // Tasks — agenda is the source of truth; taskStack is its derived view (engine/tasks.js)
  agenda: null,
  taskStack: [],
  planErrors: [],     // [PLAN:...] failures, shown to the model next turn
  planOpCount: 0,     // successful [PLAN:...] ops ever; a planning-only turn is progress
  actionOpCount: 0,   // [ACTION:...] tags ever dispatched; mainLoop's progress signal
  journal: null,      // episodic memory: records + model notes (world/journal.js)
  journalShownUpTo: 0,
  noteErrors: [],     // [NOTE:...] failures, shown to the model next turn
  lastFailures: [],
  pickupPausedUntil: 0,  // auto-pickup holds off until then (after a give)
  joinedAt: 0,           // when this session spawned in the world, for online=
  prevSnapshot: null,    // the previous turn's context values, for DELTA=
  skipBlocks: new Set(),
  pendingBlueprint: null,
  consecutivePlaceFails: 0,
  // Crafting
  portableCraftingTable: null,  // {x,y,z} of table WE placed, null if we didn't
  // Chat
  // Claude client (claude -p child process)
  claudeChild: null,
  // Config (set by bot.js)
  BOT_NAME: null,
  BOT_DATA_DIR: null,
  // Personality (set by ai.js, switchable at runtime)
  personality: null,
  // Navigation flags
  navSafetyMode: null,  // null/'safe'/'water'/'hazard' — set by navigateTo, cleared on exit
  navFailReason: null,  // detailed failure reason from last navigateTo failure
  navIntent: null,       // dig intent for the running nav op ('harvest'|'clear'|'clear-no-tool'|'survive') — read by digBlock; set by navigateTo/digHeading
  navToolNeed: null,     // set by digBlock when it REFUSES a tool-gated block ({need, block, pos}); nav bails so the AI crafts the tool or re-issues with :skiptool
  // (staircase direction + DB pathfind cache now live on per-run strategy ctx — see navigation.js)
  // Database (set by memory.js init)
  db: null,
  stmts: {},
  // Engine
  engineRunning: false,
  // Debug mode (set by bot.js from --debug launch param)
  debugMode: false,
  // Subtitles (recent sound events as accessibility-style subtitles)
  recentSubtitles: [],  // [{ text, x, y, z, dist, age, category }]
  // Result of the last look/view/scan query, surfaced to the model as LOOKED= for one cycle
  lastObservation: null,  // { ts, text }
  // High-resolution context views the model asked for with [CTX:...]. Rendered into the
  // NEXT context build and cleared — one-shot, see ai/ctxProviders.js.
  ctxRequests: [],  // [{ name, args }]
}
