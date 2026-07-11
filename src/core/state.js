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
  lastActionUsername: null,
  loopRunning: false,
  msgPending: false,
  noActionRounds: 0,
  idleAnnounced: false,  // true once the model has reported going idle; gates idle self-checks

  messageQueue: [],
  // Tasks
  taskStack: [],
  lastFailures: [],
  skipBlocks: new Set(),
  pendingBlueprint: null,
  consecutivePlaceFails: 0,
  // Crafting
  portableCraftingTable: null,  // {x,y,z} of table WE placed, null if we didn't
  // Chat
  chatHistory: new Map(),
  MAX_HISTORY: 20,
  // Rolling event log — concise history of what happened (actions, chat, outcomes)
  eventLog: [],       // [{ ts, msg }]
  MAX_EVENT_LOG: 15,
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
}
