// A tiny language server for the lsp client tests. Words are identifiers;
// `def NAME` defines NAME; a line with ERROR or WARN gets a diagnostic there.
// FAKE_LSP_CHUNKED=1 writes every message a few bytes at a time.
// FAKE_LSP_SILENT=1 never publishes diagnostics and reports indexing instead.
import { writeFileSync } from 'node:fs';

const docs = new Map();
let buffer = Buffer.alloc(0);
const chunked = process.env.FAKE_LSP_CHUNKED === '1';
const silent = process.env.FAKE_LSP_SILENT === '1';
let nextId = 1000;

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  if (!chunked) return process.stdout.write(frame);
  for (let i = 0; i < frame.length; i += 3) process.stdout.write(frame.subarray(i, i + 3));
}

function wordAt(text, position) {
  const line = text.split('\n')[position.line] ?? '';
  let start = position.character;
  let end = position.character;
  while (start > 0 && /\w/.test(line[start - 1])) start--;
  while (end < line.length && /\w/.test(line[end])) end++;
  return line.slice(start, end);
}

function occurrences(word) {
  const out = [];
  for (const [uri, text] of docs) {
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(new RegExp(`\\b${word}\\b`, 'g'))) {
        out.push({ uri, range: { start: { line: index, character: match.index }, end: { line: index, character: match.index + word.length } } });
      }
    });
  }
  return out;
}

function publish(uri, version) {
  if (silent) return;
  const diagnostics = [];
  docs.get(uri).split('\n').forEach((line, index) => {
    for (const [word, severity] of [['ERROR', 1], ['WARN', 2]]) {
      const at = line.indexOf(word);
      if (at !== -1) diagnostics.push({ range: { start: { line: index, character: at }, end: { line: index, character: at + word.length } }, severity, message: `found ${word}: ${line.trim()}\nsecond line`, source: 'fake', code: severity });
    }
  });
  setTimeout(() => send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics } }), 20);
}

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) {
    if (message.id >= 1000 && process.env.FAKE_LSP_RECORD) writeFileSync(process.env.FAKE_LSP_RECORD, JSON.stringify(message.result));
    return;
  }
  switch (method) {
    case 'initialize':
      return send({ id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true }, serverInfo: { name: 'fake', root: params.rootUri } } });
    case 'initialized':
      send({ id: nextId++, method: 'workspace/configuration', params: { items: [{ section: 'fake' }, { section: 'other' }] } });
      if (silent) send({ method: '$/progress', params: { token: 't', value: { kind: 'begin', title: 'Indexing' } } });
      return;
    case 'textDocument/didOpen':
      docs.set(params.textDocument.uri, params.textDocument.text);
      return publish(params.textDocument.uri, params.textDocument.version);
    case 'textDocument/didChange':
      docs.set(params.textDocument.uri, params.contentChanges.at(-1).text);
      return publish(params.textDocument.uri, params.textDocument.version);
    case 'textDocument/definition': {
      const word = wordAt(docs.get(params.textDocument.uri), params.position);
      const hit = occurrences(word).find((location) => (docs.get(location.uri).split('\n')[location.range.start.line] ?? '').includes(`def ${word}`));
      return send({ id, result: hit ? [{ targetUri: hit.uri, targetRange: hit.range, targetSelectionRange: hit.range }] : null });
    }
    case 'textDocument/references':
      return send({ id, result: occurrences(wordAt(docs.get(params.textDocument.uri), params.position)) });
    case 'textDocument/hover': {
      const word = wordAt(docs.get(params.textDocument.uri), params.position);
      return send({ id, result: word ? { contents: { kind: 'markdown', value: `**${word}**: thing` } } : null });
    }
    case 'textDocument/documentSymbol': {
      const symbols = [];
      docs.get(params.textDocument.uri).split('\n').forEach((line, index) => {
        const match = /^(\s*)def (\w+)/.exec(line);
        if (!match) return;
        const range = { start: { line: index, character: 0 }, end: { line: index, character: line.length } };
        const symbol = { name: match[2], kind: 12, range, selectionRange: range, children: [] };
        if (match[1] && symbols.length) symbols.at(-1).children.push({ ...symbol, kind: 6 });
        else symbols.push(symbol);
      });
      return send({ id, result: symbols });
    }
    case 'workspace/symbol':
      return send({ id, result: occurrences(params.query).filter((location) => docs.get(location.uri).split('\n')[location.range.start.line].includes(`def ${params.query}`)).map((location) => ({ name: params.query, kind: 12, location, containerName: 'mod' })) });
    case 'shutdown':
      return send({ id, result: null });
    case 'exit':
      return process.exit(0);
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
