// raceAbort must not leave a rejection unhandled when the raced promise rejects. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const { raceAbort } = require('../src/core/tick')

test('a rejecting promise rejects raceAbort and leaves nothing unhandled', async () => {
  const unhandled = []
  const on = (e) => unhandled.push(e)
  process.on('unhandledRejection', on)
  try {
    await assert.rejects(raceAbort(Promise.reject(new Error('Block not in view')), 1000), /Block not in view/)
    await new Promise(r => setTimeout(r, 50))
    assert.deepStrictEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', on)
  }
})
