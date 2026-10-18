import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { openSystemPromptAdapter, completeHistorySystem as adapt } from '../dist/system-prompt-adapter.js';
import { SYSTEM_PROMPT } from '../dist/agent.js';
import { WIKI_MCP_INSTRUCTIONS } from '../dist/tools.js';
const mcpInstructions = () => ({ wiki: WIKI_MCP_INSTRUCTIONS });
const completeHistorySystem = (body, strategy, prompt) => adapt(body, strategy, prompt, mcpInstructions());

const root = process.argv[2];
assert.ok(root, 'evidence_root_required');
const original = JSON.parse(readFileSync(root + '/png-ui-01a1494c-ready/product-request.body'));
const received = [];
const upstream = createServer((req, res) => { void (async () => {
  assert.equal(req.url, '/anthropic/v1/messages?beta=true');
  assert.equal(req.headers['x-api-key'], 'local-receiver-key');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  received.push(JSON.parse(Buffer.concat(chunks)));
  if (req.headers['x-test-hold'] === '1') { res.writeHead(503); res.write('{'); return; }
  res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"capture_only"}');
})(); });
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const controller = new AbortController();
const options = { upstream: 'http://127.0.0.1:' + upstream.address().port + '/anthropic', apiKey: 'local-receiver-key',
  model: original.model, productPrompt: SYSTEM_PROMPT, signal: controller.signal, maxBodyBytes: 20000, mcpInstructions };
const adapter = await openSystemPromptAdapter(options);
const post = (body, key = adapter.apiKey) => fetch(adapter.baseUrl + '/v1/messages?beta=true', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body),
});
try {
  const response = await post(original); assert.equal(response.status, 503); await response.arrayBuffer();
  assert.deepEqual(received, [completeHistorySystem(original, 'in-history', SYSTEM_PROMPT)]);
  for (const body of [{ ...original, model: 'different-model' }, { ...original, system: 'unbound' }, { ...original, messages: 'invalid' }]) {
    const rejected = await post(body); assert.equal(rejected.status, 502); await rejected.arrayBuffer();
  }
  const unauthorized = await post(original, 'incorrect-key'); assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
  const invalidUtf8 = await fetch(adapter.baseUrl + '/v1/messages', { method: 'POST',
    headers: { 'x-api-key': adapter.apiKey }, body: Buffer.from([0xff]) });
  assert.equal(invalidUtf8.status, 502); await invalidUtf8.arrayBuffer();
  const oversized = await post({ ...original, metadata: { value: 'x'.repeat(21000) } });
  assert.equal(oversized.status, 502); await oversized.arrayBuffer();
  assert.equal(received.length, 1);
  const streaming = await fetch(adapter.baseUrl + '/v1/messages?beta=true', { method: 'POST',
    headers: { 'x-api-key': adapter.apiKey, 'x-test-hold': '1' }, body: JSON.stringify(original) });
  assert.equal(streaming.status, 503);
  controller.abort();
  await assert.rejects(streaming.arrayBuffer());
  const aborted = await post(original); assert.equal(aborted.status, 502); await aborted.arrayBuffer();
  assert.equal(received.length, 2);
  await assert.rejects(openSystemPromptAdapter(options));
} finally {
  await adapter.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
console.log(JSON.stringify({ passed: true, cases: 10, localCaptureCount: received.length, generatedResponses: 0, externalRequests: 0 }));
