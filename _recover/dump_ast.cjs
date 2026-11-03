// Dump the statement structure of handleRoute to see how the parser groups it.
const ts = require('typescript')
const fs = require('fs')

const text = fs.readFileSync(process.argv[2], 'utf8')
const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

function lineOf(node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function walk(node, depth, maxDepth) {
  if (depth > maxDepth) return
  const kind = ts.SyntaxKind[node.kind]
  if (node.kind === ts.SyntaxKind.FunctionDeclaration || node.kind === ts.SyntaxKind.IfStatement ||
      node.kind === ts.SyntaxKind.Block || node.kind === ts.SyntaxKind.ExpressionStatement) {
    const name = node.name ? node.name.getText(sf) : ''
    console.log(`${'  '.repeat(depth)}${kind} ${name} @L${lineOf(node)}`)
  }
  ts.forEachChild(node, c => {
    if (c.kind === ts.SyntaxKind.FunctionDeclaration) walk(c, depth + 1, maxDepth)
  })
}

console.log('=== all top-level function declarations ===')
ts.forEachChild(sf, n => {
  if (n.kind === ts.SyntaxKind.FunctionDeclaration) {
    console.log('  ' + (n.name ? n.name.getText(sf) : '<anon>') + ' @L' + lineOf(n) + ' body=' + (n.body ? 'yes' : 'NULL'))
  }
})
const target = process.argv[3] || 'handleRoute'
ts.forEachChild(sf, n => {
  if (n.kind === ts.SyntaxKind.FunctionDeclaration && n.name && n.name.getText(sf) === target) {
    console.log(`=== ${target} @L${lineOf(n)} ===`)
    const body = n.body
    console.log('  (body parsed) statements=' + body.statements.length)
    for (const stmt of body.statements) {
      const k = ts.SyntaxKind[stmt.kind]
      let extra = ''
      if (stmt.kind === ts.SyntaxKind.IfStatement) {
        extra = stmt.expression.getText(sf).slice(0, 70)
      }
      let txt = ''
      try { txt = stmt.getText(sf).split('\n')[0].slice(0, 80) } catch (e) { txt = '<no text>' }
      console.log('  L' + String(lineOf(stmt)).padStart(5) + ' ' + k + ' :: ' + txt)
    }
  }
})
