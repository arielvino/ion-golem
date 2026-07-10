// Shared blueprint parser — used by ai.js (chat-driven build) and mcp-server.js
// (structure-progress query, a separate process). Pure: no logging, no throw on
// empty input. Returns null when there's no LEGEND or no placeable blocks, else
// { blocks: [{x,y,z,block}], materials: {name: count}, legend }.
function parseBlueprint(raw) {
  const lines = raw.trim().split('\n').map(l => l.trim()).filter(l => l)
  const legendLine = lines.find(l => l.startsWith('LEGEND:'))
  if (!legendLine) return null
  const legend = {}
  for (const pair of legendLine.replace('LEGEND:', '').split(',')) {
    const [code, block] = pair.trim().split('=')
    if (code && block) legend[code.trim()] = block.trim()
  }
  legend['_'] = null
  legend['.'] = null
  const blocks = []
  const layerLines = lines.filter(l => /^L\d+:/.test(l)).sort((a, b) => {
    return parseInt(a.match(/L(\d+)/)[1]) - parseInt(b.match(/L(\d+)/)[1])
  })
  for (const ll of layerLines) {
    const y = parseInt(ll.match(/L(\d+)/)[1])
    const data = ll.replace(/^L\d+:/, '').trim()
    const rows = data.split(';')
    for (let z = 0; z < rows.length; z++) {
      const row = rows[z].trim()
      for (let x = 0; x < row.length; x++) {
        const ch = row[x]
        const blockName = legend[ch]
        if (blockName && blockName !== 'air') {
          blocks.push({ x, y, z, block: blockName })
        }
      }
    }
  }
  if (blocks.length === 0) return null
  const materials = {}
  for (const b of blocks) { materials[b.block] = (materials[b.block] || 0) + 1 }
  return { blocks, materials, legend }
}

module.exports = { parseBlueprint }
