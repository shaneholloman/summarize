import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const cjsDir = path.resolve(__dirname, '..', 'dist', 'cjs')
await mkdir(cjsDir, { recursive: true })
await writeFile(
  path.join(cjsDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`
)
