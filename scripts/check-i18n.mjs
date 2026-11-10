// Verifies that every t('key') used in client.js exists in both dictionaries,
// and that both dictionaries carry the same key set.
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const block = source.slice(source.indexOf('const MESSAGES'), source.indexOf('let translate ='))

const tables = {}
for (const lang of ['zh', 'en']) {
  const marker = block.indexOf(`  ${lang}: {`)
  if (marker === -1) throw new Error(`missing dictionary ${lang}`)
  let depth = 0
  let index = block.indexOf('{', marker)
  const start = index
  for (; index < block.length; index += 1) {
    if (block[index] === '{') depth += 1
    else if (block[index] === '}') {
      depth -= 1
      if (depth === 0) { index += 1; break }
    }
  }
  const body = block.slice(start, index)
  tables[lang] = new Set([...body.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]))
}

const used = new Set([...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]))
const problems = []

// Keys routed through objects (labelKey / hintKey / BADGES) never appear inside t(...).
const referenced = (key) => source.includes(`'${key}'`)

for (const key of used) {
  for (const lang of ['zh', 'en']) if (!tables[lang].has(key)) problems.push(`${lang} misses key ${key}`)
}
for (const key of tables.zh) if (!tables.en.has(key)) problems.push(`en misses key ${key}`)
for (const key of tables.en) if (!tables.zh.has(key)) problems.push(`zh misses key ${key}`)
for (const key of tables.zh) if (!used.has(key) && !referenced(key)) problems.push(`unused key ${key}`)

console.log(`zh ${tables.zh.size} keys, en ${tables.en.size} keys, used ${used.size}`)

// Nothing outside the dictionaries may carry Chinese literals: that text would leak
// into the English UI. Comments are stripped first so prose stays free.
const stripped = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
const start = stripped.indexOf('const MESSAGES')
const end = stripped.indexOf('let translate =')
const outside = stripped.slice(0, start) + stripped.slice(end)
/*
 * The CJK check runs on code only. Chinese section labels are fine in the dictionary
 * and in README, but a bare literal in the component tree is a bug.
 */
for (const line of outside.split('\n')) {
  if (/[\u3400-\u9fff]/.test(line)) problems.push(`chinese literal outside dictionaries: ${line.trim()}`)
}

if (problems.length === 0) {
  console.log('i18n ok')
} else {
  for (const problem of problems) console.log(`- ${problem}`)
  process.exitCode = 1
}
