#!/usr/bin/env node
// audit-db.js — is the block DB telling the truth about the world right now?
//
// The DB is a MEMORY, so some drift is by design (the bot mined it, a mob broke it,
// it was never re-observed). This measures how much, and — more usefully — what SHAPE
// the drift has, which distinguishes normal memory decay from a perception bug:
//
//   - mismatches spread evenly over block types, in chunks the bot has not revisited
//     => normal staleness
//   - a specific block type systematically wrong, or drift inside currently-loaded
//     chunks the bot is standing in => the writer is putting bad data in
//
// Usage: node tools/audit-db.js [sampleSize]
const path = require('path')
const fs = require('fs')
const os = require('os')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const state = require('../src/core/state')

const SAMPLE = parseInt(process.argv[2] || '4000', 10)
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '26.1'
const BOT = process.env.AUDIT_BOT || 'BroDev'

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'iongolem', BOT, 'blocks.db')
if (!fs.existsSync(DB_PATH)) { console.error(`no db at ${DB_PATH}`); process.exit(1) }

const Database = require('better-sqlite3')
const db = new Database(DB_PATH, { readonly: true })

async function main() {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'AuditBot', version: VERSION })
  state.bot = bot
  await new Promise((res, rej) => {
    bot.once('spawn', res); bot.once('error', rej)
    setTimeout(() => rej(new Error('spawn timeout')), 60000)
  })
  let cols = 0
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const n = bot.world.getColumns().length
    if (n === cols && n > 40) break
    cols = n
  }
  const p = bot.entity.position.floored()
  console.log(`audit bot at ${p}, ${cols} columns loaded`)
  console.log(`db: ${DB_PATH}`)
  console.log(`rows: ${db.prepare('select count(*) c from blocks').get().c}\n`)

  // Only audit rows whose chunk is actually loaded right now — otherwise we would be
  // comparing against a null world and calling every row a mismatch.
  const rows = db.prepare(`
    SELECT x, y, z, name, seen_at FROM blocks
    WHERE x BETWEEN ? AND ? AND z BETWEEN ? AND ? AND y BETWEEN ? AND ?
    ORDER BY RANDOM() LIMIT ?
  `).all(p.x - 120, p.x + 120, p.z - 120, p.z + 120, p.y - 60, p.y + 60, SAMPLE)

  let checked = 0, match = 0
  const byType = new Map()   // dbName -> { n, bad, becameMap: Map<actual, count> }
  for (const r of rows) {
    const live = bot.blockAt(new Vec3(r.x, r.y, r.z))
    if (!live) continue            // chunk not loaded — not auditable
    checked++
    const actual = live.name
    let t = byType.get(r.name)
    if (!t) byType.set(r.name, t = { n: 0, bad: 0, became: new Map() })
    t.n++
    if (actual === r.name) { match++; continue }
    t.bad++
    t.became.set(actual, (t.became.get(actual) || 0) + 1)
  }

  const pct = (a, b) => b ? ((a / b) * 100).toFixed(1) : '0.0'
  console.log(`checked ${checked} loaded rows: ${match} match, ${checked - match} drift (${pct(checked - match, checked)}%)\n`)

  const worst = [...byType.entries()]
    .filter(([, t]) => t.bad > 0)
    .sort((a, b) => b[1].bad - a[1].bad)
    .slice(0, 12)
  if (worst.length) {
    console.log('drift by db block type (db said X, world actually has Y):')
    for (const [name, t] of worst) {
      const top = [...t.became.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, c]) => `${n} x${c}`).join(', ')
      console.log(`  ${name.padEnd(22)} ${String(t.bad).padStart(5)}/${String(t.n).padEnd(5)} bad (${pct(t.bad, t.n).padStart(5)}%)  -> ${top}`)
    }
  } else {
    console.log('no drift found')
  }

  bot.quit(); process.exit(0)
}
main().catch(e => { console.error('audit failed:', e.message); process.exit(1) })
