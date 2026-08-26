import { readFileSync } from 'node:fs'
const t = readFileSync('providers-regen.tmp', 'utf8')
console.log('has CRLF:', t.includes('\r\n'))
const i = t.indexOf("'alibaba': {")
console.log('idx:', i)
console.log(JSON.stringify(t.slice(i - 4, i + 60)))
const j = t.indexOf('},', i)
console.log('close sample:', JSON.stringify(t.slice(j - 8, j + 6)))
