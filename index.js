// Registers four PHP tools backed by a real language server. OpenCode v2 runs
// no language server of its own (anomalyco/opencode#38528), so the plugin
// starts the server itself and answers from it.

import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientFor, formatDiagnostics, languageId } from './client.js'

// Symfony Language Tools reads routes, services and Twig at runtime, so it sees
// what intelephense cannot: a missing route parameter, a template that does not
// exist, a deprecated config key. The project declares how to boot itself in
// .symfony-lsp.json, which is also how a container is reached. A project
// without that file has not opted in, and booting it anyway would run an
// application the user never configured.
export function symfonyAvailable(root) {
  return typeof root === 'string' && existsSync(`${root}/.symfony-lsp.json`)
}

const twigOrPhp = (file) => (file.endsWith('.twig') ? 'twig' : 'php')

export function projectRoot(file, fallback) {
  let dir = dirname(resolve(file))
  for (;;) {
    if (existsSync(`${dir}/composer.json`) || existsSync(`${dir}/vendor/autoload.php`)) return dir
    const parent = dirname(dir)
    if (parent === dir) return fallback
    dir = parent
  }
}

export function checkFile(file, base) {
  if (typeof file !== 'string' || file.length === 0) throw new Error('`file` must be a path')
  const path = resolve(base ?? process.cwd(), file)
  if (!existsSync(path)) throw new Error(`no such file: ${path}`)
  if (!statSync(path).isFile()) throw new Error(`not a file: ${path}`)
  if (!languageId(path)) throw new Error(`not a PHP file: ${path}`)
  return path
}

// Diagnostics accept Twig, because Symfony Language Tools reads it and
// intelephense cannot.
export function checkAnyFile(file, base) {
  if (typeof file !== 'string' || file.length === 0) throw new Error('`file` must be a path')
  const path = resolve(base ?? process.cwd(), file)
  if (!existsSync(path)) throw new Error(`no such file: ${path}`)
  if (!statSync(path).isFile()) throw new Error(`not a file: ${path}`)
  return path
}

export function formatLocations(result, label) {
  const list = Array.isArray(result) ? result : result ? [result] : []
  if (list.length === 0) return `no ${label}`
  return list
    .map((item) => {
      const file = fileURLToPath(item.uri)
      const line = item.range.start.line + 1
      const column = item.range.start.character + 1
      return `${file}:${line}:${column}`
    })
    .join('\n')
}

export function formatHover(result) {
  if (!result?.contents) return 'no hover information'
  const contents = result.contents
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((part) => (typeof part === 'string' ? part : part.value ?? '')).join('\n')
  }
  return contents.value ?? 'no hover information'
}

const POSITION_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'PHP file, absolute or relative to the project' },
    line: { type: 'number', description: 'One-based line number' },
    column: { type: 'number', description: 'One-based column number' },
  },
  required: ['file', 'line', 'column'],
  additionalProperties: false,
}

const FILE_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'PHP file, absolute or relative to the project' },
  },
  required: ['file'],
  additionalProperties: false,
}

export const TOOLS = {
  php_diagnostics: {
    name: 'php_diagnostics',
    description:
      'Errors and warnings for one PHP or Twig file. In a Symfony project with a .symfony-lsp.json file, it also reports missing route parameters, missing templates and deprecated config keys. Use it before running a build or a test suite.',
    input: FILE_SCHEMA,
  },
  php_definition: {
    name: 'php_definition',
    description: 'Where the symbol at this position is declared.',
    input: POSITION_SCHEMA,
  },
  php_references: {
    name: 'php_references',
    description: 'Every place the symbol at this position is used across the project.',
    input: POSITION_SCHEMA,
  },
  php_hover: {
    name: 'php_hover',
    description: 'Signature and docblock of the symbol at this position.',
    input: POSITION_SCHEMA,
  },
}

export default {
  id: 'vasilvestre.opencode-php-lsp',

  async setup(ctx) {
    const options = ctx?.options ?? {}
    const command = options.command ?? ['intelephense', '--stdio']
    const timeoutMs = options.timeoutMs ?? 30000
    const fallback = ctx?.directory ?? process.cwd()

    // resolve() against the worktree, so a relative path from the agent lands
    // where the agent thinks it does.
    const target = (file) => checkFile(file, fallback)
    const client = (file) => clientFor({ root: projectRoot(file, fallback), command, timeoutMs })

    const handlers = {
      async php_diagnostics({ file }) {
        const path = checkAnyFile(file, fallback)
        const root = projectRoot(path, fallback)
        const symfony = symfonyAvailable(root)
        if (!symfony && !languageId(path)) throw new Error(`not a PHP file: ${path}`)
        const lsp = symfony
          ? clientFor({
              root,
              command: ['symfony-lsp'],
              timeoutMs: options.symfonyTimeoutMs ?? 120000,
              initializationOptions: { workspaceTrust: true },
              language: twigOrPhp,
            })
          : client(path)
        const uri = await lsp.open(path)
        if (symfony) {
          await lsp.waitForIndex(options.symfonyTimeoutMs ?? 120000)
          // The push that follows the index is the real answer; the earlier
          // empty one is cached, so read past it.
          const fresh = await lsp.waitForDiagnostics(uri, 15000, { fresh: true })
          if (fresh !== null) return formatDiagnostics(fresh, path)
        }
        const diagnostics = await lsp.waitForDiagnostics(uri, timeoutMs)
        if (diagnostics === null) return `${path}: no diagnostics arrived within ${timeoutMs}ms`
        return formatDiagnostics(diagnostics, path)
      },
      async php_definition(input) {
        const path = target(input.file)
        const lsp = client(path)
        const result = await lsp.request('textDocument/definition', await lsp.position(path, input.line, input.column))
        return formatLocations(result, 'definition')
      },
      async php_references(input) {
        const path = target(input.file)
        const lsp = client(path)
        const params = await lsp.position(path, input.line, input.column)
        const result = await lsp.request('textDocument/references', {
          ...params,
          context: { includeDeclaration: true },
        })
        return formatLocations(result, 'references')
      },
      async php_hover(input) {
        const path = target(input.file)
        const lsp = client(path)
        const result = await lsp.request('textDocument/hover', await lsp.position(path, input.line, input.column))
        return formatHover(result)
      },
    }

    await ctx.tool.transform((editor) => {
      for (const tool of Object.values(TOOLS)) {
        editor.add({
          ...tool,
          options: { codemode: false },
          execute: (input) => handlers[tool.name](input ?? {}),
        })
      }
    })
  },
}
