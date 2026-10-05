// chunkLightFix.js — load network light data the right way round.
//
// prismarine-chunk 1.41.0 (pc/1.18 ChunkColumn, used up to 26.1) reads the light arrays
// of map_chunk / update_light with BitArray.readBuffer, which takes every 8 bytes as one
// big-endian long — the block-state format. Light is plain bytes, two nibbles each, low
// nibble first. The result: within every run of 16 cells along x, the light of local x t
// lands on x t^14 (a torch at x=4 lights x=10 instead). Its own disk loader
// (_loadBlockLightNibbles) wraps the bytes directly, which is right; this does the same.
//
// Must be required before mineflayer creates its Chunk class (before createBot): the
// pc/1.18 loader builds that class from this module on each call.
const BitArray = require('prismarine-chunk/src/pc/common/BitArrayNoSpan')

const colPath = require.resolve('prismarine-chunk/src/pc/1.18/ChunkColumn.js')
const makeColumn = require(colPath)

function loadParsedLight (skyLight, blockLight, skyLightMask, blockLightMask, emptySkyLightMask, emptyBlockLightMask) {
  const readSection = (sections, data, lightMask, pLightMask, emptyMask, pEmptyMask) => {
    let next = 0
    const incoming = BitArray.fromLongArray(pLightMask, 1)
    const incomingEmpty = BitArray.fromLongArray(pEmptyMask, 1)
    for (let y = 0; y < sections.length; y++) {
      const isEmpty = incomingEmpty.get(y)
      if (!incoming.get(y) && !isEmpty) continue
      emptyMask.set(y, isEmpty)
      lightMask.set(y, 1 - isEmpty)
      sections[y] = isEmpty
        ? new BitArray({ bitsPerValue: 4, capacity: 4096 })
        : new BitArray({ bitsPerValue: 4, capacity: 4096, data: Uint8Array.from(data[next++]).buffer })
    }
  }
  readSection(this.skyLightSections, skyLight, this.skyLightMask, skyLightMask, this.emptySkyLightMask, emptySkyLightMask)
  readSection(this.blockLightSections, blockLight, this.blockLightMask, blockLightMask, this.emptyBlockLightMask, emptyBlockLightMask)
}

require.cache[colPath].exports = (Block, mcData) => {
  const ChunkColumn = makeColumn(Block, mcData)
  ChunkColumn.prototype.loadParsedLight = loadParsedLight
  return ChunkColumn
}
