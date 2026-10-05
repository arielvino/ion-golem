#!/usr/bin/env node
// check-natural-blocks.js — sanity check for src/config/natural-blocks.js.
// 1. every listed name must be a real block in this version;
// 2. prints how many blocks are tells by default;
// 3. applies the rules to the sample-visible.js dumps and lists the tells each sample saw.
// Usage: node tools/check-natural-blocks.js [dump dir, default /tmp/visible-samples]
const fs = require('fs')
const path = require('path')
const { isNoise, NOISE } = require('../src/config/natural-blocks')
const VERSION = process.env.MC_VERSION || '26.1'
const DIR = process.argv[2] || '/tmp/visible-samples'

const names = new Set(require('minecraft-data')(VERSION).blocksArray.map(b => b.name))
const unknown = [...NOISE.keys()].filter(n => !names.has(n))
console.log(`${VERSION}: ${names.size} blocks, ${NOISE.size} listed as noise somewhere, ${names.size - NOISE.size} always tells`)
if (unknown.length) console.log(`NOT BLOCKS in ${VERSION}: ${unknown.join(', ')}`)

for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'by-biome.json').sort()) {
  const s = JSON.parse(fs.readFileSync(path.join(DIR, f)))
  const tells = []
  for (const [biome, rows] of Object.entries(s.byBiome || {}))
    for (const [n, c] of rows) if (!isNoise(n, s.dimension, biome)) tells.push(`${n}@${biome} ${c}`)
  console.log(`${s.spec.padEnd(30)} ${tells.length ? tells.join(', ') : '-'}`)
}
