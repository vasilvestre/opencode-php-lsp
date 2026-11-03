// A stand-in for the PHP language server. It answers the four requests the
// plugin makes, so the tests run without intelephense installed.
const send = (message) => {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

let buffer = Buffer.alloc(0)
let file = null

// Diagnostics arrive once, on didOpen, keyed to the opened document.
const publish = () =>
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: file,
      diagnostics: [
        {
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
          severity: 1,
          source: 'phpstan',
          message: 'Cannot return string from a method declared to return int.',
        },
      ],
    },
  })

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const at = buffer.indexOf('\r\n\r\n')
    if (at < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, at).toString())[1])
    if (buffer.length < at + 4 + length) return
    const message = JSON.parse(buffer.subarray(at + 4, at + 4 + length).toString())
    buffer = buffer.subarray(at + 4 + length)
    handle(message)
  }
})

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { capabilities: { textDocumentSync: 1, definitionProvider: true } },
    })
    // A server request the client must answer, or it hangs in real life.
    send({ jsonrpc: '2.0', id: 99, method: 'workspace/configuration', params: { items: [{}] } })
    return
  }
  if (message.method === 'textDocument/didOpen') {
    file = message.params.textDocument.uri
    publish()
    return
  }
  if (message.method === 'shutdown' || message.method === 'exit') return
  if (message.id === undefined) return

  const range = { start: { line: 20, character: 4 }, end: { line: 20, character: 9 } }
  const results = {
    'textDocument/definition': [{ uri: file, range }],
    'textDocument/references': [
      { uri: file, range },
      { uri: file, range: { start: { line: 21, character: 8 }, end: { line: 21, character: 13 } } },
    ],
    'textDocument/hover': { contents: { kind: 'markdown', value: 'public function setCreatedBy(Customer $c): void' } },
  }
  send({ jsonrpc: '2.0', id: message.id, result: results[message.method] ?? null })
}
