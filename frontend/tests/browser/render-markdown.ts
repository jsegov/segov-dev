import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { compileFunction } from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

export function renderMarkdownFixture(content: string) {
  const frontendRoot = path.resolve(__dirname, '../..')
  const filename = path.join(frontendRoot, 'components/markdown-renderer.tsx')
  // Playwright transforms imported JSX into component-test descriptors. Compile
  // this real server component in memory with TypeScript's React JSX runtime
  // instead, so the browser fixture contains the HTML the app renderer produces.
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2022,
    },
  })
  const requireFromFrontend = createRequire(path.join(frontendRoot, 'package.json'))
  const moduleExports = {} as { MarkdownRenderer: React.ComponentType<{ content: string }> }
  const load = (id: string) =>
    requireFromFrontend(id.startsWith('@/') ? path.join(frontendRoot, id.slice(2)) : id)
  compileFunction(outputText, ['require', 'exports'], { filename })(load, moduleExports)
  return renderToStaticMarkup(React.createElement(moduleExports.MarkdownRenderer, { content }))
}
