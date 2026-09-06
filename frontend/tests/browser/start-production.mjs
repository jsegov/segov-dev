import { cpSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const frontendRoot = fileURLToPath(new URL('../..', import.meta.url))
const standaloneRoot = path.join(frontendRoot, '.next/standalone/frontend')

// Next's standalone output omits public/static assets. Stage them exactly as
// required when serving the production build without an external asset CDN.
cpSync(path.join(frontendRoot, 'public'), path.join(standaloneRoot, 'public'), {
  recursive: true,
})
cpSync(path.join(frontendRoot, '.next/static'), path.join(standaloneRoot, '.next/static'), {
  recursive: true,
})

await import(pathToFileURL(path.join(standaloneRoot, 'server.js')).href)
