// ANSI color helpers for console output
const c = {
  reset:   '\x1b[0m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
}

const color = (clr, text) => `${clr}${text}${c.reset}`

module.exports = { c, color }
