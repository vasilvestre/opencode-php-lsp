// Minimal LSP client over stdio. It speaks just enough JSON-RPC for the
// operations OpenCode v2 has no runtime for: diagnostics, definition,
// references, hover. One child process per project root, reused by every call.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const LANGUAGES = { '.php': 'php' }

export function languageId(file) {
  const dot = file.lastIndexOf('.')
  return dot < 0 ? null : LANGUAGES[file.slice(dot).toLowerCase()] || null
}

// LSP frames a message as a header block, a blank line, then the JSON body.
export function frame(message) {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

// Feeds raw stdout chunks and yields whole messages. A partial frame stays in
// the buffer until the rest arrives.
export function readFrames(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk])
  const out = []
  for (;;) {
    const headerEnd = state.buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return out
    const header = state.buffer.subarray(0, headerEnd).toString()
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      // No length means a frame we cannot parse. Drop the header and retry so
      // one bad message does not wedge the stream.
      state.buffer = state.buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (state.buffer.length < bodyStart + length) return out
    const body = state.buffer.subarray(bodyStart, bodyStart + length).toString()
    state.buffer = state.buffer.subarray(bodyStart + length)
    try {
      out.push(JSON.parse(body))
    } catch {
      // A truncated or non-JSON body is not worth throwing over: the next call
      // will time out and say so.
    }
  }
}

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

export function formatDiagnostics(diagnostics, file) {
  if (!diagnostics || diagnostics.length === 0) return `${file}: no diagnostics`
  return diagnostics
    .map((d) => {
      const line = d.range.start.line + 1
      const column = d.range.start.character + 1
      const severity = SEVERITY[d.severity] ?? 'issue'
      const source = d.source ? ` [${d.source}]` : ''
      return `${file}:${line}:${column} ${severity}${source}: ${d.message}`
    })
    .join('\n')
}

export class PhpLsp {
  constructor({ command = ['intelephense', '--stdio'], root, timeoutMs = 30000, initializationOptions = null, language = languageId }) {
    this.command = command
    this.root = root
    this.timeoutMs = timeoutMs
    this.initializationOptions = initializationOptions
    this.language = language
    this.child = null
    this.state = { buffer: Buffer.alloc(0) }
    this.nextId = 1
    this.pending = new Map()
    this.diagnostics = new Map()
    this.waiters = new Map()
    this.opened = new Set()
    this.stderr = ''
    this.indexed = false
    this.indexWaiters = []
  }

  start() {
    if (this.child) return this.child
    this.child = spawn(this.command[0], this.command.slice(1), {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000)
    })
    this.child.stdout.on('data', (chunk) => {
      for (const message of readFrames(this.state, chunk)) this.handle(message)
    })
    // A server that dies must not leave the plugin holding a dead handle.
    this.child.on('exit', () => {
      this.child = null
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error(`language server exited. ${this.stderr.trim()}`))
      }
      this.pending.clear()
    })
    return this.child
  }

  handle(message) {
    // Symfony Language Tools publishes an empty list before it boots the
    // application, then publishes again once its runtime index is ready. The
    // second push is the answer, so the caller waits for that index first.
    if (message.method === '$/progress' && message.params?.value?.message === 'Runtime index ready') {
      this.indexed = true
      for (const resolve of this.indexWaiters.splice(0)) resolve()
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const uri = message.params.uri
      this.diagnostics.set(uri, message.params.diagnostics ?? [])
      const waiter = this.waiters.get(uri)
      if (waiter) {
        this.waiters.delete(uri)
        waiter(message.params.diagnostics ?? [])
      }
      return
    }
    if (message.id !== undefined && message.method) {
      // Server to client requests. Answering keeps the server moving; refusing
      // to answer blocks it.
      const result =
        message.method === 'workspace/configuration'
          ? (message.params?.items ?? []).map(() => null)
          : null
      this.notify({ jsonrpc: '2.0', id: message.id, result })
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  }

  write(message) {
    if (!this.child) throw new Error('language server is not running')
    this.child.stdin.write(frame(message))
  }

  notify(message) {
    this.write(message)
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  async initialize() {
    if (this.ready) return
    this.start()
    const rootUri = pathToFileURL(this.root).href
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri,
      ...(this.initializationOptions ? { initializationOptions: this.initializationOptions } : {}),
      workspaceFolders: [{ uri: rootUri, name: this.root.split('/').pop() }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: {},
          publishDiagnostics: {},
          definition: {},
          references: {},
          hover: {},
        },
      },
    })
    await this.ready
    this.notify({ jsonrpc: '2.0', method: 'initialized', params: {} })
  }

  async open(file) {
    await this.initialize()
    const uri = pathToFileURL(file).href
    if (this.opened.has(uri)) return uri
    const text = readFileSync(file, 'utf8')
    this.notify({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: this.language(file) ?? 'php', version: 1, text },
      },
    })
    this.opened.add(uri)
    return uri
  }

  // The server pushes diagnostics when it is ready. Wait for the push that
  // follows this open, with a deadline, because indexing a large project is
  // slower than any fixed sleep.
  waitForIndex(timeoutMs = this.timeoutMs) {
    if (this.indexed) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.indexWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async waitForDiagnostics(uri, timeoutMs = this.timeoutMs, { fresh = false } = {}) {
    if (!fresh && this.diagnostics.has(uri)) return this.diagnostics.get(uri)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(uri)
        resolve(null)
      }, timeoutMs)
      this.waiters.set(uri, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  }

  async position(file, line, column) {
    await this.open(file)
    return { textDocument: { uri: pathToFileURL(file).href }, position: { line: line - 1, character: column - 1 } }
  }

  async dispose() {
    const child = this.child
    if (!child) return
    this.child = null
    try {
      this.notify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: null })
      this.notify({ jsonrpc: '2.0', method: 'exit', params: null })
    } catch {
      // The server may already be gone; killing below covers it.
    }
    setTimeout(() => child.kill(), 300).unref?.()
  }
}

export function createClient(options) {
  return new PhpLsp(options)
}

// One client per root: the server indexes the whole project, so starting a
// second one doubles the cost for no benefit.
const clients = new Map()

export function clientFor({ root, command, timeoutMs, initializationOptions, language }) {
  const key = `${root}|${(command ?? []).join(' ')}`
  let client = clients.get(key)
  if (!client) {
    client = new PhpLsp({ root, command, timeoutMs, initializationOptions, language })
    clients.set(key, client)
  }
  return client
}

export function disposeAll() {
  for (const client of clients.values()) client.dispose()
  clients.clear()
}

process.on('exit', disposeAll)
