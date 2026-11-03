// Find which node contains a given line, walking the whole tree.
const ts = require('typescript')
const fs = require('fs')

const text = fs.readFileSync(process.argv[2], 'utf8')
const targetLine = parseInt(process.argv[3], 10) - 1
const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const pos = sf.getPositionOfLineAndCharacter(targetLine, 0)
console.log('looking for line', targetLine + 1, 'at pos', pos)

let path = []
function visit(node) {
  const start = node.getStart(sf)
  const end = node.getEnd()
  if (pos >= start && pos < end) {
    const k = ts.SyntaxKind[node.kind]
    const name = node.name ? node.name.getText(sf) : ''
    const line = sf.getLineAndCharacterOfPosition(start).line + 1
    path.push({ k, name, line, start, end })
    ts.forEachChild(node, visit)
  }
}
ts.forEachChild(sf, visit)

for (const p of path) {
  console.log(`  ${p.k} ${p.name} @L${p.line} [${p.start}..${p.end}]`)
}
