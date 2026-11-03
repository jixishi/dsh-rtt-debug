// Locate the first true syntax error with the TypeScript parser itself.
const ts = require('typescript')
const fs = require('fs')

const file = process.argv[2]
const text = fs.readFileSync(file, 'utf8')
const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

const diags = sf.parseDiagnostics || []
console.log(`parse diagnostics: ${diags.length}`)
for (const d of diags.slice(0, 12)) {
  const pos = sf.getLineAndCharacterOfPosition(d.start)
  console.log(`  line ${pos.line + 1}, col ${pos.character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  const lineStart = text.lastIndexOf('\n', d.start) + 1
  const lineEnd = text.indexOf('\n', d.start)
  console.log(`      | ${text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 110)}`)
}
