// Task stack (LIFO) — each entry is { t: "short title", d: "details/context", r: "reason" }
const fs = require('fs')
const path = require('path')
const state = require('../core/state')
const { logTaskAction } = require('../world/memory')

const STACK_FILE = () => path.join(state.BOT_DATA_DIR, 'task-stack.json')

function saveStack() {
  try { fs.writeFileSync(STACK_FILE(), JSON.stringify({ stack: state.taskStack })) } catch (e) { console.warn('  [TASKS] stack save err:', e.message) }
}

function loadStack() {
  try {
    const f = STACK_FILE()
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      state.taskStack = (data.stack || []).map(e => typeof e === 'string' ? { t: e, d: '', r: '' } : e)
      if (state.taskStack.length > 0) console.log(`  [STACK] restored: ${stackTitles()}`)
    }
  } catch (e) { console.warn('  [TASKS] stack load err:', e.message) }
}

function stackTitles() { return state.taskStack.map(e => e.t).join(' > ') }

function stackTitlesWithSrc() {
  return state.taskStack.map(e => {
    let s = e.t
    if (e.d) s += `(${e.d})`
    if (e.r) s += `[reason:${e.r}]`
    return s
  }).join(' > ')
}

function stackTop() { return state.taskStack.length > 0 ? state.taskStack[state.taskStack.length - 1] : null }
function stackTopTitle() { const top = stackTop(); return top ? top.t : null }

function stackPush(title, details, reason) {
  state.taskStack.push({ t: title, d: details || '', r: reason || '' })
  saveStack()
  console.log(`  [STACK] push: ${title} | stack: ${stackTitles()}`)
  logTaskAction('push', title, JSON.stringify({ d: details, r: reason }), stackTitles())
}

function stackPop() {
  const e = state.taskStack.pop(); saveStack()
  console.log(`  [STACK] pop: ${e?.t} | stack: ${state.taskStack.length > 0 ? stackTitles() : '(empty)'}`)
  logTaskAction('pop', e?.t, null, stackTitles() || '(empty)')
  return e
}

module.exports = {
  saveStack, loadStack, stackTitles, stackTitlesWithSrc,
  stackTop, stackTopTitle, stackPush, stackPop,
}
