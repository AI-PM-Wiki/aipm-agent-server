import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from '../dist/agent.js';

const [root, output, only] = process.argv.slice(2);
assert.ok(root && output, 'evidence_root_and_output_required');
assert.ok(only === undefined || only === 'after', 'unsupported_capture_selection');
mkdirSync(output, { recursive: true });
const current = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
for (const [name, source] of [['before', root + '/aipm-wt-svg-native-01a14992/agent-server'], ['after', current]]) {
  if (only && name !== only) continue;
  const directory = output + '/' + name;
  for (const sub of ['', '/scratch', '/sdk-home', '/tmp']) mkdirSync(directory + sub, { recursive: true });
  let child, captured, posts = 0;
  const server = createServer((req, res) => { void (async () => {
    if (req.method === 'HEAD' && req.url === '/api/hello') { res.writeHead(404); res.end(); return; }
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/messages?beta=true'); assert.equal(++posts, 1);
    assert.equal(req.headers['x-api-key'], 'local-capture-only');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured = Buffer.concat(chunks); writeFileSync(directory + '/request.body', captured, { mode: 0o600, flag: 'wx' });
    child.send('captured'); res.writeHead(503); res.end();
  })().catch(error => { res.destroy(error); child?.kill('SIGTERM'); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'local-capture-only', CLAUDE_CONFIG_DIR: directory + '/sdk-home',
    TMPDIR: directory + '/tmp', CLAUDE_CODE_MAX_RETRIES: '0', ANTHROPIC_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' });
  child = spawn(process.execPath, [current + 'test/system-prompt-sdk-child.mjs', source, root, directory, baseUrl], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const stderr = []; child.stderr.on('data', bytes => stderr.push(bytes));
  const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(code, 0); assert.equal(posts, 1); assert.ok(captured);
  const body = JSON.parse(captured);
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'system']);
  const complete = body.messages.at(-1).content.startsWith(SYSTEM_PROMPT + '\n\n');
  assert.equal(complete, name === 'after');
  assert.equal(body.max_tokens, 8192); assert.equal(body.model, 'deepseek-flash');
  const input = JSON.parse(readFileSync(root + '/png-ui-01a1494c-ready/plan/meta/image-direct-01a1472a/prepared/product-input.json'));
  const images = body.messages[0].content.filter(block => block.type === 'image');
  assert.equal(images.length, 1); assert.equal(images[0].source.data, input.context[0].imageData);
  results.push({ name, productPromptComplete: complete, localPosts: posts, upstreamForwards: 0, fakeModelResponses: 0,
    requestSha256: hash(captured), imageSha256: hash(Buffer.from(images[0].source.data, 'base64')),
    roles: body.messages.map(message => message.role), toolCount: body.tools.length, maxTokens: body.max_tokens,
    outcome: JSON.parse(readFileSync(directory + '/outcome.json')), exitCode: code });
}
writeFileSync(output + '/results.json', JSON.stringify({ passed: true, network: 'OS sandbox localhost only', results }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: true, results }));
