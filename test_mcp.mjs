/**
 * Full test suite for the file-tools MCP server.
 * Uses stdio transport — sends JSON-RPC messages directly.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import fs from 'fs';

const SERVER = './file-tools-mcp-server/dist/index.js';
const WORKDIR = '/tmp/mcp-test';

// ── helpers ──────────────────────────────────────────────────────────────────

let msgId = 1;
let proc;
let rl;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    proc.stdin.write(msg + '\n');
  });
}

async function callTool(name, args) {
  const res = await send('tools/call', { name, arguments: args });
  if (res.error) throw new Error(JSON.stringify(res.error));
  const result = res.result;
  return {
    text: result.content.map(c => c.text).join(''),
    isError: result.isError ?? false,
  };
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function expect(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     got:      ${JSON.stringify(actual)}`);
  }
}

function expectContains(label, actual, substring) {
  const ok = typeof actual === 'string' && actual.includes(substring);
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
    console.log(`     expected to contain: ${JSON.stringify(substring)}`);
    console.log(`     got: ${JSON.stringify(actual)}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Prep workdir
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  fs.mkdirSync(WORKDIR, { recursive: true });

  // Start server
  proc = spawn('node', [SERVER], { env: { ...process.env, TRANSPORT: 'stdio' } });
  proc.stderr.on('data', () => {}); // suppress

  rl = createInterface({ input: proc.stdout });
  rl.on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  });

  // Initialize
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  });

  // ═══════════════════════════════════════════════════════
  // GROUP: create_file
  // ═══════════════════════════════════════════════════════
  console.log('\n📁 create_file');

  const f1 = `${WORKDIR}/hello.txt`;
  let r = await callTool('create_file', { description: 'test', path: f1, file_text: 'Hello, World!\nLine 2\nLine 3\n' });
  expect('creates new file → success message', r.text, `File created successfully: ${f1}`);
  expect('creates new file → not error', r.isError, false);

  // Overwrite existing
  r = await callTool('create_file', { description: 'test', path: f1, file_text: 'new content' });
  expect('overwrite existing → error flag', r.isError, true);
  expectContains('overwrite existing → message', r.text, 'File already exists:');
  expectContains('overwrite existing → path in message', r.text, f1);

  // Auto-create nested dirs
  const nested = `${WORKDIR}/deep/nested/file.txt`;
  r = await callTool('create_file', { description: 'test', path: nested, file_text: 'deep content\n' });
  expect('nested dirs auto-created → success', r.text, `File created successfully: ${nested}`);
  expect('nested dirs actually exist', fs.existsSync(nested), true);

  // Empty content
  const fempty = `${WORKDIR}/empty.txt`;
  r = await callTool('create_file', { description: 'test', path: fempty, file_text: '' });
  expect('empty file → success', r.isError, false);
  expect('empty file → 0 bytes', fs.statSync(fempty).size, 0);

  // ═══════════════════════════════════════════════════════
  // GROUP: view — files
  // ═══════════════════════════════════════════════════════
  console.log('\n👁️  view — files');

  r = await callTool('view', { path: f1 });
  expect('view 3-line file → line 1', r.text.split('\n')[0], '     1\tHello, World!');
  expect('view 3-line file → line 2', r.text.split('\n')[1], '     2\tLine 2');
  expect('view 3-line file → line 3', r.text.split('\n')[2], '     3\tLine 3');
  expect('view 3-line file → not error', r.isError, false);

  // Empty file
  r = await callTool('view', { path: fempty });
  expect('view empty file → empty string', r.text, '');
  expect('view empty file → not error', r.isError, false);

  // view_range basic
  r = await callTool('view', { path: f1, view_range: [2, 3] });
  expectContains('view_range [2,3] → contains line 2', r.text, '     2\tLine 2');
  expectContains('view_range [2,3] → contains footer', r.text, '[4 lines total]');

  // view_range -1 end
  r = await callTool('view', { path: f1, view_range: [2, -1] });
  expectContains('view_range [2,-1] → contains line 2', r.text, '     2\tLine 2');
  expectContains('view_range [2,-1] → contains line 3', r.text, '     3\tLine 3');
  expectContains('view_range [2,-1] → footer', r.text, '[4 lines total]');

  // view_range end beyond file — clamped
  r = await callTool('view', { path: f1, view_range: [2, 999] });
  expect('view_range end > lines → not error', r.isError, false);
  expectContains('view_range end > lines → still shows content', r.text, 'Line 2');

  // view_range start out of bounds
  r = await callTool('view', { path: f1, view_range: [100, 200] });
  expect('view_range start OOB → error', r.isError, true);
  expectContains('view_range start OOB → message', r.text, 'Invalid `view_range`');

  // view_range single line
  r = await callTool('view', { path: f1, view_range: [1, 1] });
  expectContains('view_range [1,1] → line 1 content', r.text, 'Hello, World!');
  expectContains('view_range [1,1] → footer', r.text, '[4 lines total]');

  // Path not found
  r = await callTool('view', { path: `${WORKDIR}/nope.txt` });
  expect('view missing path → error', r.isError, true);
  expectContains('view missing path → message', r.text, 'Path not found:');

  // Binary / hex escape
  const binFile = `${WORKDIR}/binary.bin`;
  fs.writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xFF]));
  r = await callTool('view', { path: binFile });
  expectContains('binary file → hex escapes present', r.text, '\\x');

  // Large file truncation
  const bigFile = `${WORKDIR}/big.txt`;
  const bigLines = Array.from({ length: 1000 }, (_, i) =>
    `This is line number ${String(i+1).padStart(4,'0')} with extra padding content to grow char count fast`
  );
  fs.writeFileSync(bigFile, bigLines.join('\n') + '\n');
  r = await callTool('view', { path: bigFile });
  expectContains('large file → truncation marker', r.text, '< truncated lines');
  expectContains('large file → shows beginning', r.text, '     1\t');
  expectContains('large file → shows end', r.text, '  1000\t');

  // ═══════════════════════════════════════════════════════
  // GROUP: view — directories
  // ═══════════════════════════════════════════════════════
  console.log('\n📂 view — directories');

  const dirRoot = `${WORKDIR}/mydir`;
  fs.mkdirSync(`${dirRoot}/sub1/subsub`, { recursive: true });
  fs.mkdirSync(`${dirRoot}/sub2`, { recursive: true });
  fs.writeFileSync(`${dirRoot}/sub1/file.txt`, 'abc');
  fs.writeFileSync(`${dirRoot}/sub1/subsub/deep.txt`, 'deep content');
  fs.writeFileSync(`${dirRoot}/.hidden`, 'hidden');

  r = await callTool('view', { path: dirRoot });
  expectContains('dir listing → root entry', r.text, dirRoot);
  expectContains('dir listing → shows sub1', r.text, 'sub1');
  expectContains('dir listing → shows sub2', r.text, 'sub2');
  expectContains('dir listing → shows file.txt', r.text, 'file.txt');
  expect('dir listing → hides .hidden', r.text.includes('.hidden'), false);
  expect('dir listing → 2-level limit (no subsub contents)', r.text.includes('deep.txt'), false);

  // Missing directory
  r = await callTool('view', { path: `${WORKDIR}/no_such_dir` });
  expect('view missing dir → error', r.isError, true);

  // ═══════════════════════════════════════════════════════
  // GROUP: str_replace
  // ═══════════════════════════════════════════════════════
  console.log('\n✏️  str_replace');

  const sf = `${WORKDIR}/replace_test.txt`;
  fs.writeFileSync(sf, 'First line\nSecond line\nThird line\nFourth line\n');

  // Basic replace
  r = await callTool('str_replace', { description: 'test', path: sf, old_str: 'Second line', new_str: 'REPLACED' });
  expect('basic replace → success', r.text, `Successfully replaced string in ${sf}`);
  expect('basic replace → not error', r.isError, false);
  expect('basic replace → content updated', fs.readFileSync(sf, 'utf8').includes('REPLACED'), true);
  expect('basic replace → old gone', fs.readFileSync(sf, 'utf8').includes('Second line'), false);

  // Delete via empty new_str
  r = await callTool('str_replace', { description: 'test', path: sf, old_str: 'Third line\n', new_str: '' });
  expect('delete via empty new_str → success', r.isError, false);
  expect('delete → line removed', fs.readFileSync(sf, 'utf8').includes('Third line'), false);

  // Not found
  r = await callTool('str_replace', { description: 'test', path: sf, old_str: 'THIS DOES NOT EXIST', new_str: 'x' });
  expect('not found → error', r.isError, true);
  expectContains('not found → message', r.text, 'String to replace not found in');
  expectContains('not found → view hint', r.text, 'view tool');

  // Multiple matches
  fs.writeFileSync(sf, 'line\nline\nline\n');
  r = await callTool('str_replace', { description: 'test', path: sf, old_str: 'line', new_str: 'x' });
  expect('multiple match → error', r.isError, true);
  expect('multiple match → message', r.text, 'String to replace found multiple times, must be unique');

  // File not found
  r = await callTool('str_replace', { description: 'test', path: `${WORKDIR}/nope.txt`, old_str: 'x', new_str: 'y' });
  expect('file not found → error', r.isError, true);
  expectContains('file not found → message', r.text, 'File not found:');

  // Prepend (replace first line to insert before it)
  fs.writeFileSync(sf, 'AAA\nBBB\nCCC\n');
  r = await callTool('str_replace', { description: 'test', path: sf, old_str: 'AAA', new_str: 'ZERO\nAAA' });
  expect('prepend via replace → success', r.isError, false);
  expect('prepend → ZERO now first', fs.readFileSync(sf, 'utf8').startsWith('ZERO'), true);

  // Append (extend last line)
  r = await callTool('str_replace', { description: 'test', path: sf, old_str: 'CCC\n', new_str: 'CCC\nDDD\n' });
  expect('append via replace → success', r.isError, false);
  expectContains('append → DDD now in file', fs.readFileSync(sf, 'utf8'), 'DDD');

  // str_replace on empty file
  fs.writeFileSync(`${WORKDIR}/empty2.txt`, '');
  r = await callTool('str_replace', { description: 'test', path: `${WORKDIR}/empty2.txt`, old_str: 'anything', new_str: 'x' });
  expect('str_replace on empty file → error', r.isError, true);

  // ═══════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════
  proc.kill();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failed tests:');
    failures.forEach(f => console.log(`  • ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
