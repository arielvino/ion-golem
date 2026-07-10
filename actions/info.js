// Info actions — wiki
const state = require('../state')
const { sendChat } = require('../utils')
const WIKI_EXPANSIONS = require('../config/wiki-expansions.json')

function expandWikiTerms(text) {
  for (const [term, expansion] of Object.entries(WIKI_EXPANSIONS)) {
    text = text.replaceAll(term, expansion)
  }
  return text
}

async function doWiki(query) {
  const cleanQuery = query.replace(/\b(how to|how do i|what is|in minecraft)\b/gi, '').replace(/\s+/g, ' ').trim() || query
  console.log(`  [WIKI] searching: ${cleanQuery}${cleanQuery !== query ? ` (cleaned from: ${query})` : ''}`)
  try {
    const searchUrl = `https://minecraft.wiki/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&srlimit=1&format=json`
    const searchRes = await fetch(searchUrl)
    const searchData = await searchRes.json()
    const results = searchData.query?.search
    if (!results || results.length === 0) {
      sendChat(`Wiki: nothing found for "${query}"`)
      console.log('  [WIKI] no results')
      return
    }
    const title = results[0].title

    const extractUrl = `https://minecraft.wiki/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=true&explaintext=true&format=json`
    const extractRes = await fetch(extractUrl)
    const extractData = await extractRes.json()
    const page = Object.values(extractData.query.pages)[0]
    let info = page.extract || ''

    const sectionsUrl = `https://minecraft.wiki/api.php?action=parse&page=${encodeURIComponent(title)}&prop=sections&format=json`
    const sectionsRes = await fetch(sectionsUrl)
    const sectionsData = await sectionsRes.json()
    const sections = sectionsData.parse?.sections || []

    const targetSections = ['Crafting', 'Obtaining', 'Usage', 'Breaking']
    for (const sec of sections) {
      if (targetSections.some(t => sec.line.includes(t))) {
        try {
          const secUrl = `https://minecraft.wiki/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=${sec.index}&format=json`
          const secRes = await fetch(secUrl)
          const secData = await secRes.json()
          const wikitext = secData.parse?.wikitext?.['*'] || ''
          let plain = wikitext
          // Match {{Crafting ... }} templates (multiline, handles nested braces)
          const craftTemplates = [...wikitext.matchAll(/\{\{[Cc]rafting[\s\S]*?\}\}/g)]
          for (const ct of craftTemplates) {
            const body = ct[0]
            // Split on | that start a param (handles multiple params per line)
            const params = body.replace(/\{\{[Cc]rafting\s*/, '').replace(/\}\}\s*$/, '')
            const paramPairs = [...params.matchAll(/\|\s*(\w+)\s*=\s*([^|}\n]*(?:\n(?!\s*\|)[^|}\n]*)*)/g)]
            const slots = {}
            let output = ''
            let description = ''
            let ingredients = ''
            for (const [, key, val] of paramPairs) {
              const k = key.trim()
              const v = val.trim()
              if (k === 'Output') output = v
              else if (k === 'description') description = v
              else if (k === 'ingredients') ingredients = v
              else if (/^[A-C][1-3]$/.test(k)) slots[k] = v
            }
            const slotIngredients = [...new Set(Object.values(slots))].join(' + ')
            const allIngredients = slotIngredients || ingredients || ''
            let recipeStr = ''
            if (output && allIngredients) {
              recipeStr = `Recipe: ${allIngredients} → ${output}`
            } else if (output) {
              recipeStr = `Recipe: → ${output}`
            }
            if (description) recipeStr += ` (${description})`
            if (recipeStr) {
              plain = plain.replace(ct[0], recipeStr)
            }
          }
          plain = plain
            .replace(/\{\{[^}]*\}\}/g, '')
            .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
            .replace(/'{2,}/g, '')
            .replace(/<[^>]+>/g, '')
            .replace(/\n{2,}/g, '\n')
            .trim()
            .slice(0, 300)
          if (plain.length > 20) info += `\n[${sec.line}] ${plain}`
        } catch (e) { /* wiki section parse failure, skip */ }
      }
    }

    info = expandWikiTerms(info).slice(0, 1200).trim()
    console.log(`  [WIKI] ${title}: ${info.slice(0, 200)}...`)
    console.log(`  [WIKI] got ${info.length} chars, feeding back to AI`)
    state.messageQueue.push({
      username: 'self',
      message: `[WIKI-RESULT for "${query}"] ${title}: ${info}\n\nUse this info to update your plan. If it shows a recipe exists, push appropriate [STACK] and [ACTION] tags. Your training data may be outdated — trust the wiki.`,
      historyAs: state.lastActionUsername || 'self'
    })
  } catch (err) {
    console.error('  [WIKI] error:', err.message)
    state.messageQueue.push({
      username: 'self',
      message: `[WIKI-RESULT for "${query}"] Lookup failed: ${err.message}. Try the action anyway or check recipes= field.`,
      historyAs: state.lastActionUsername || 'self'
    })
  }
}

module.exports = { doWiki }
