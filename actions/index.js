// Action dispatch — routes action strings to handler functions
const state = require('../state')
const { AbortError, isAborted } = require('../tick')
const { c, color } = require('../lib/colors')
const { logEvent, normalizeItemName, recordFailure } = require('../utils')
const { doFollow, doCome, doFlee, doMount, doDismount, doSail, doGoto, doStaircase, doMove, doTunnel, doTurn, doSwimUp } = require('./movement')
const { doAttack } = require('./combat')
const { doMine, doCollect } = require('./mining')
const { doDrop, doEquip, doUnequip, doGive, doRequire, doTake, doDeposit, doInspect } = require('./inventory')
const { doEat, doSleep } = require('./vitals')
const { doPlace, doBuild } = require('./building')
const { doCraft } = require('./crafting')
const { doSmelt } = require('./smelting')
const { doWiki } = require('./info')
const { doUse, doFill } = require('./interaction')
const { doEval } = require('./eval')
const { switchPersonality } = require('../ai')
const ranges = require('../config/ranges')

// Actions worth logging to event history (skip noisy/trivial ones)
const LOG_ACTIONS = new Set(['mine', 'craft', 'smelt', 'build', 'place', 'attack', 'give', 'equip', 'goto', 'fill', 'require', 'take', 'deposit'])

async function executeAction(actionStr, username, opts = {}) {
  const parts = actionStr.split(':')
  const action = parts[0]
  const target = parts.slice(1).join(':')
  console.log(color(c.green, `\n  [${state.actionQueue.length} left] exec: ${action}${target ? ':' + target : ''}`))

  const prevTask = state.currentTask
  let succeeded = false
  // Handlers report their real outcome by returning a boolean: `false` = the action
  // verifiably failed, `true`/`undefined` = success. `undefined` is treated as success
  // so not-yet-migrated / info-only handlers keep their old behavior. Only an explicit
  // `false` (or a thrown error) marks the action failed. This is the crux of the
  // "false success" fix: the switch no longer hard-codes success.
  let result
  try {
    switch (action) {
      case 'follow': result = doFollow(username); break
      case 'stop': {
        const engine = require('../engine')
        engine.interrupt()
        break
      }
      case 'come': result = await doCome(username); break
      case 'attack': result = await doAttack(target); break
      case 'mine': result = await doMine(target); break
      case 'collect': result = await doCollect(); break
      case 'drop': result = await doDrop(target); break
      case 'eat': result = await doEat(); break
      case 'sleep': result = await doSleep(); break
      case 'equip': result = await doEquip(target); break
      case 'unequip': result = await doUnequip(target); break
      case 'place': result = await doPlace(target); break
      case 'craft': {
        const craftParts = target.split(':')
        const craftTarget = craftParts[0]
        const craftCount = craftParts.length > 1 ? parseInt(craftParts[1], 10) : 1
        result = await doCraft(craftTarget, isNaN(craftCount) || craftCount < 1 ? 1 : craftCount)
        break
      }
      case 'smelt': result = await doSmelt(target); break
      case 'goto': result = await doGoto(target); break
      case 'goto~': result = await doGoto(target, { mode: 'water' }); break
      case 'goto!': result = await doGoto(target, { allowHazards: true }); break
      case 'digto': result = await doGoto(target); break
      case 'staircase': result = await doStaircase(target); break
      case 'move': result = await doMove(target); break
      case 'tunnel': result = await doTunnel(target); break
      case 'give': result = await doGive(target, username); break
      case 'wiki': result = await doWiki(target); break
      case 'flee': result = await doFlee(); break
      case 'mount': result = await doMount(target); break
      case 'dismount': result = await doDismount(); break
      case 'sail': result = await doSail(target); break
      case 'build': result = await doBuild(); break
      case 'turn': result = await doTurn(target); break
      case 'face': result = await doTurn(target); break
      case 'fill': result = await doFill(target); break
      case 'swimup': result = await doSwimUp(); break
      case 'use': result = await doUse(target); break
      case 'eval': result = await doEval(target); break
      case 'require': result = await doRequire(target); break
      case 'take': result = await doTake(target); break
      case 'deposit': result = await doDeposit(target); break
      case 'store': result = await doDeposit(target); break
      case 'inspect': result = await doInspect(target); break
      case 'open': result = await doInspect(target); break
      case 'look': case 'see': {
        // isSeen: find blocks/entities by name using x-ray (findBlock/nearestEntity),
        // but only report those with transparent line-of-sight from bot's eyes.
        const { hasLineOfSight, TRANSPARENT } = require('../vision')
        const { Vec3 } = require('vec3')
        const { debugChat } = require('../utils')
        const lookBot = state.bot
        const lookMcData = require('minecraft-data')(lookBot.version)
        const normalized = normalizeItemName(target)
        const eyePos = lookBot.entity.position.offset(0, 1.62, 0)
        const found = []

        // Search entities
        for (const e of Object.values(lookBot.entities)) {
          if (e === lookBot.entity) continue
          const eName = (e.name || '').toLowerCase()
          const eUser = (e.username || '').toLowerCase()
          if (!eName.includes(normalized) && !eUser.includes(normalized)) continue
          if (!e.position) continue
          const dist = lookBot.entity.position.distanceTo(e.position)
          if (dist > ranges.sight.lookEntities) continue
          const visible = hasLineOfSight(eyePos, e.position, e.height || 1.8)
          found.push({ name: e.username || e.name, type: 'entity', x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), dist: Math.round(dist), visible })
        }

        // Search blocks: palette-skip scan of loaded chunks (cheap to full range),
        // then LOS-gate nearest-first with the same multi-face occlusion test the
        // survey uses (a single center ray self-occludes solid blocks), stopping
        // once we have enough visible hits.
        const LOOK_RANGE = ranges.sight.lookBlocks
        const { scanCandidates, resolveTargets } = require('../chunkScan')
        const { blockVisible } = require('../visibility')
        // omni (cosHalf -1): "do I see any X anywhere", not just ahead. Exposure-culled.
        const hits = scanCandidates({ origin: eyePos, cosHalf: -1, maxDistance: LOOK_RANGE, count: 256, idToName: resolveTargets(normalized) })
        let visibleSoFar = 0
        for (const h of hits) {
          if (blockVisible(eyePos, h.x, h.y, h.z)) {
            found.push({ name: h.name, type: 'block', x: h.x, y: h.y, z: h.z, dist: Math.round(h.dist), visible: true })
            if (++visibleSoFar >= ranges.sight.lookReportCap) break
          }
        }
        console.log(`  [look] "${normalized}" scan hits=${hits.length} visible=${visibleSoFar}`)

        // Only report what the bot can actually see — no x-ray
        const visible = found.filter(f => f.visible)
        const lookMsg = visible.length === 0
          ? `look "${target}": none visible within ${LOOK_RANGE} blocks`
          : `look "${target}": ${visible.map(f => `${f.name}@${f.x},${f.y},${f.z}(${f.dist}m)`).join(', ')}`
        state.lastObservation = { ts: Date.now(), text: lookMsg }
        debugChat(`[look] ${visible.length === 0 ? `No "${target}" visible within ${LOOK_RANGE} blocks.` : `SEE: ${visible.map(f => `${f.name}@${f.x},${f.y},${f.z}(${f.dist}m)`).join(', ')}`}`)
        break
      }
      case 'scan': {
        const { castVisionRays, formatVision, dirToYaw } = require('../vision')
        const { upsertVisionChunked } = require('../memory')
        const { debugChat } = require('../utils')
        const yaw = target ? dirToYaw(target) : null
        const spread = yaw !== null ? Math.PI / 4 : Math.PI // 45° cone or full sphere
        const result = castVisionRays(12, ranges.sight.rayScanBlocks, 'see', yaw, spread)
        if (result) {
          await upsertVisionChunked(result)
          const vis = formatVision(result)
          const dirLabel = target || 'all'
          state.lastObservation = { ts: Date.now(), text: `scan ${dirLabel}: ${vis.slice(0, 200)}` }
          debugChat(`[scan ${dirLabel}] ${vis.slice(0, 200)}`)
          console.log(`  [scan ${dirLabel}] ${result.allBlocks.length} blocks stored`)
        }
        break
      }
      case 'view': case 'survey': {
        // "What do I see now?" — chunk-truth discovery gated by FOV + line-of-sight.
        // target: 'omni'/'all'/'around' = no FOV limit; a number = full FOV in degrees.
        const { surveyVisible, formatSurvey } = require('../visibility')
        const { debugChat } = require('../utils')
        const t = (target || '').toLowerCase().trim()
        const opts = {}
        if (t === 'omni' || t === 'all' || t === 'around') opts.omni = true
        else if (t && !isNaN(parseFloat(t))) opts.fovDegrees = parseFloat(t)
        const result = surveyVisible(opts)
        if (result) {
          const survStr = formatSurvey(result)
          state.lastObservation = { ts: Date.now(), text: `view${survStr}` }
          debugChat(`[view]${survStr}`)
          console.log(`  [view] ${result.visibleCount} visible / ${result.candidatesScanned} scanned (fov ${result.fov}, r${result.maxDistance})`)
        } else {
          debugChat('[view] no bot/entity yet')
        }
        break
      }
      case 'personality': {
        const p = switchPersonality(target)
        const { sendChat } = require('../utils')
        sendChat(`Personality switched! ${p.slice(0, 60)}...`)
        break
      }
      default: console.log(`  unknown: ${action}`)
    }
    // Only an explicit `false` return means the action failed; undefined = success.
    succeeded = (result !== false)
  } catch (err) {
    if (err instanceof AbortError) {
      // Abort is neither success nor failure. Re-throw so backgroundTask records the
      // task's terminal status as 'aborted' (not 'failed') and preserves the queue.
      console.log(color(c.yellow, `  ${action}: aborted`))
      state.currentTask = null
      throw err
    }
    console.error(color(c.red, `  ERR ${action}: ${err.message}`))
    if (!opts.quiet) {
      recordFailure(`${action}:${target} failed: ${err.message}`)
    }
    state.currentTask = null
  }

  // Log significant actions to event history with their REAL outcome. Skip when the
  // action ended because of an abort (isAborted) — that's an interruption, not a result.
  if (LOG_ACTIONS.has(action) && !isAborted()) {
    logEvent(`${action}${target ? ':' + target : ''} ${succeeded ? 'done' : 'failed'}`)
  }

  return succeeded
}

module.exports = { executeAction }
