// Unit tests for picking food to eat. Run: node --test
const test = require('node:test')
const assert = require('node:assert')
const state = require('../src/core/state')
const { edibleFoods } = require('../src/actions/vitals')

const registry = require('minecraft-data')('26.1')
const botWith = (...names) => ({ registry, inventory: { items: () => names.map(name => ({ name, count: 1 })) } })

test('food comes from the registry foods table (items carry no food data)', () => {
  const foods = edibleFoods(botWith('bread', 'cobblestone', 'stick'))
  assert.deepEqual(foods.map(f => f.name), ['bread'])
})

test('best food first; harmful food only after everything else', () => {
  const foods = edibleFoods(botWith('rotten_flesh', 'apple', 'cooked_beef', 'spider_eye', 'bread'))
  const names = foods.map(f => f.name)
  assert.deepEqual(names.slice(0, 3), ['cooked_beef', 'bread', 'apple'])
  assert.deepEqual(names.slice(3).sort(), ['rotten_flesh', 'spider_eye'])
})

test('nothing edible → empty list', () => {
  state.bot = null
  assert.deepEqual(edibleFoods(botWith('dirt')), [])
})
