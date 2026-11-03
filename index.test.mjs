import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The client keeps a child process alive, so the test run never exits without
// this.
after(() => disposeAll())
import { fileURLToPath } from 'node:url'

import { PhpLsp, disposeAll, frame, readFrames, formatDiagnostics, languageId } from './client.js'
import plugin, { TOOLS, checkFile, formatHover, formatLocations as locations, projectRoot } from './index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(here, 'fixtures', 'fake-lsp.mjs')

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'php-lsp-'))
  writeFileSync(join(dir, 'composer.json'), '{}')
  writeFileSync(join(dir, 'Broken.php'), '<?php\nfinal class Broken {}\n')
  return dir
}

test('frame writes a Content-Length header then the body', () => {
  const out = frame({ jsonrpc: '2.0', id: 1, method: 'x' })
  assert.match(out, /^Content-Length: \d+\r\n\r\n\{/)
  const [, length, body] = /^Content-Length: (\d+)\r\n\r\n([\s\S]+)$/.exec(out)
  assert.equal(Number(length), Buffer.byteLength(body))
})

test('readFrames keeps a partial frame until the rest arrives', () => {
  const state = { buffer: Buffer.alloc(0) }
  const whole = frame({ id: 1, result: 'ok' })
  const cut = whole.length - 6
  assert.deepEqual(readFrames(state, Buffer.from(whole.slice(0, cut))), [])
  assert.deepEqual(readFrames(state, Buffer.from(whole.slice(cut))), [{ id: 1, result: 'ok' }])
})

test('readFrames returns two messages sent in one chunk', () => {
  const state = { buffer: Buffer.alloc(0) }
  const chunk = Buffer.from(frame({ id: 1 }) + frame({ id: 2 }))
  assert.deepEqual(readFrames(state, chunk), [{ id: 1 }, { id: 2 }])
})

test('readFrames survives a frame with no length', () => {
  const state = { buffer: Buffer.alloc(0) }
  const out = readFrames(state, Buffer.from('X-Nope: 1\r\n\r\n' + frame({ id: 3 })))
  assert.deepEqual(out, [{ id: 3 }])
})

test('languageId knows PHP and nothing else', () => {
  assert.equal(languageId('/a/B.php'), 'php')
  assert.equal(languageId('/a/B.PHP'), 'php')
  assert.equal(languageId('/a/B.twig'), null)
  assert.equal(languageId('/a/Makefile'), null)
})

test('formatDiagnostics says when a file is clean', () => {
  assert.equal(formatDiagnostics([], '/a/B.php'), '/a/B.php: no diagnostics')
})

test('formatDiagnostics prints one line per problem', () => {
  const text = formatDiagnostics(
    [
      {
        range: { start: { line: 4, character: 2 } },
        severity: 1,
        source: 'intelephense',
        message: 'Undefined function',
      },
    ],
    '/a/B.php',
  )
  assert.equal(text, '/a/B.php:5:3 error [intelephense]: Undefined function')
})

test('formatHover reads the markdown form', () => {
  assert.equal(formatHover({ contents: { kind: 'markdown', value: 'sig' } }), 'sig')
  assert.equal(formatHover(null), 'no hover information')
})

test('formatLocations prints path:line:column', () => {
  const result = [{ uri: 'file:///a/B.php', range: { start: { line: 2, character: 6 } } }]
  assert.equal(locations(result), '/a/B.php:3:7')
  assert.equal(locations([], 'definition'), 'no definition')
})

test('projectRoot walks up to the nearest composer.json', () => {
  const dir = project()
  try {
    const deep = join(dir, 'src', 'Domain')
    writeFileSync(join(dir, 'x.php'), '')
    assert.equal(projectRoot(join(deep, 'x.php'), '/fallback'), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkFile rejects a missing file and a non-PHP file', () => {
  const dir = project()
  try {
    writeFileSync(join(dir, 'notes.twig'), '')
    assert.throws(() => checkFile(join(dir, 'nope.php')), /no such file/)
    assert.throws(() => checkFile(join(dir, 'notes.twig')), /not a PHP file/)
    assert.equal(checkFile(join(dir, 'Broken.php')), resolve(dir, 'Broken.php'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client answers a server request instead of hanging', async () => {
  const dir = project()
  const client = new PhpLsp({ command: [process.execPath, FAKE], root: dir, timeoutMs: 5000 })
  try {
    await client.initialize()
    const uri = await client.open(join(dir, 'Broken.php'))
    const diagnostics = await client.waitForDiagnostics(uri, 5000)
    assert.equal(diagnostics.length, 1)
    assert.match(formatDiagnostics(diagnostics, 'x.php'), /Cannot return string/)
  } finally {
    await client.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('definition, references and hover come back through the client', async () => {
  const dir = project()
  const client = new PhpLsp({ command: [process.execPath, FAKE], root: dir, timeoutMs: 5000 })
  try {
    const params = await client.position(join(dir, 'Broken.php'), 21, 10)
    const definition = await client.request('textDocument/definition', params)
    assert.equal(definition.length, 1)
    assert.equal(definition[0].range.start.line, 20)

    const references = await client.request('textDocument/references', params)
    assert.equal(references.length, 2)

    const hover = await client.request('textDocument/hover', params)
    assert.match(formatHover(hover), /setCreatedBy/)
  } finally {
    await client.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('waitForIndex resolves when the runtime index ends', async () => {
  const lsp = new PhpLsp({ root: '/tmp' })
  const waiting = lsp.waitForIndex(5000)
  lsp.handle({ method: '$/progress', params: { value: { message: 'Runtime index ready' } } })
  await waiting
  assert.equal(lsp.indexed, true)
})

test('a fresh wait reads past the cached empty push', async () => {
  const lsp = new PhpLsp({ root: '/tmp' })
  const uri = 'file:///tmp/a.twig'
  lsp.handle({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } })
  const waiting = lsp.waitForDiagnostics(uri, 1000, { fresh: true })
  lsp.handle({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'boom' }] } })
  const value = await waiting
  assert.equal(value.length, 1)
})

test('a request to a dead server fails instead of hanging', async () => {
  const dir = project()
  const client = new PhpLsp({ command: [process.execPath, '-e', 'process.exit(1)'], root: dir, timeoutMs: 2000 })
  try {
    await assert.rejects(() => client.initialize(), /exited|timed out/)
  } finally {
    await client.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setup registers the four tools on the tool draft', async () => {
  const dir = project()
  const added = []
  const ctx = {
    options: { command: [process.execPath, FAKE] },
    directory: dir,
    tool: {
      transform: async (fn) => fn({ add: (tool) => added.push(tool) }),
    },
  }
  try {
    await plugin.setup(ctx)
    assert.deepEqual(added.map((t) => t.name).sort(), Object.keys(TOOLS).sort())
    for (const tool of added) {
      assert.equal(tool.options.codemode, false)
      assert.ok(tool.input.properties.file)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the registered diagnostics tool returns the server errors', async () => {
  const dir = project()
  const added = []
  const ctx = {
    options: { command: [process.execPath, FAKE], timeoutMs: 5000 },
    directory: dir,
    tool: { transform: async (fn) => fn({ add: (tool) => added.push(tool) }) },
  }
  try {
    await plugin.setup(ctx)
    const tool = added.find((t) => t.name === 'php_diagnostics')
    const text = await tool.execute({ file: 'Broken.php' })
    assert.match(text, /:5:3 error \[phpstan\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bad call throws a readable error', async () => {
  const dir = project()
  const added = []
  const ctx = {
    options: { command: [process.execPath, FAKE], timeoutMs: 5000 },
    directory: dir,
    tool: { transform: async (fn) => fn({ add: (tool) => added.push(tool) }) },
  }
  try {
    await plugin.setup(ctx)
    const tool = added.find((t) => t.name === 'php_diagnostics')
    await assert.rejects(() => tool.execute({ file: 'missing.php' }), /no such file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
