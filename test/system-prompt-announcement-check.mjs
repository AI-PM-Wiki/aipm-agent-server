import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openSystemPromptAdapter, completeHistorySystem } from '../dist/system-prompt-adapter.js';
import { SYSTEM_PROMPT } from '../dist/agent.js';
import { WIKI_MCP_INSTRUCTIONS } from '../dist/tools.js';

const [root, output] = process.argv.slice(2);
assert.ok(root && output);
const original = JSON.parse(readFileSync(root + '/png-ui-01a1494c-ready/product-request.body'));
const header = '# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n';
const valid = header + '## wiki\n' + WIKI_MCP_INSTRUCTIONS;
const conflicting = header + '## wiki\nConflicting offline instruction.';
const extra = header + '## additional\nUnsupported offline server instruction.';
const wrapped = text => '<system-reminder>\n' + text + '\n</system-reminder>';
const blocks = (...texts) => texts.map(text => ({ type: 'text', text, cache_control: { type: 'ephemeral' } }));
const variants = [
  { name: 'conflict_before_valid_string', content: wrapped(conflicting) + '\n\n' + original.messages[1].content },
  { name: 'extra_before_valid_blocks', content: blocks(extra, original.messages[1].content) },
  { name: 'conflict_before_valid_blocks', content: blocks(conflicting, valid) },
  { name: 'valid_before_extra_string', content: valid + '\n\n' + extra },
  { name: 'duplicate_matching_strings', content: valid + '\n\n' + valid, allowed: true },
  { name: 'duplicate_matching_blocks', content: blocks(valid, valid), allowed: true },
  { name: 'duplicate_matching_wrappers', content: wrapped(valid) + '\n\n' + wrapped(valid), allowed: true },
  { name: 'matching_wrapped_then_plain', content: wrapped(valid) + '\n\n' + valid, allowed: true },
  { name: 'matching_plain_then_wrapped', content: valid + '\n\n' + wrapped(valid), allowed: true },
  { name: 'shared_header_extra_server', content: valid + '\n\n## additional\nUnsupported offline server instruction.' },
  { name: 'shared_header_conflict', content: valid + '\n\n## wiki\nConflicting offline instruction.' },
  { name: 'unknown_header_after_valid', content: valid + '\n\n# MCP Server Instructions\nUnrecognized announcement.' },
  { name: 'missing_wrapper_end', content: valid + '\n\n<system-reminder>\n' + valid },
  { name: 'nested_wrapper', content: wrapped(wrapped(valid)) },
  { name: 'split_announcement_blocks', content: blocks(header, '## wiki\n' + WIKI_MCP_INSTRUCTIONS) },
  { name: 'extended_instruction', content: valid + ' additional instruction' },
  { name: 'ambiguous_instruction_paragraph', content: valid + '\n\nConflicting offline instruction.' },
  { name: 'ambiguous_unknown_supplement_after_announcement', content: valid + '\n\nUnrecognized attachment format.' },
  { name: 'unconfigured_snapshot', content: valid, snapshot: { wiki: WIKI_MCP_INSTRUCTIONS, additional: 'Unsupported.' } },
  { name: 'undefined_wiki_snapshot', content: valid, snapshot: { wiki: undefined } },
  { name: 'legal_wiki', content: original.messages[1].content, allowed: true },
  { name: 'budget_only_update', content: 'USD budget: $0.1/$0.3; $0.2 remaining', append: true, allowed: true },
  { name: 'opaque_supplement_idempotent', content: 'current supplementary state', append: true, allowed: true },
];
const received = [];
const receiver = createServer((req, res) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"local_capture_only"}');
  })().catch(error => res.destroy(error));
});
receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
let snapshot = { wiki: WIKI_MCP_INSTRUCTIONS };
const adapter = await openSystemPromptAdapter({ upstream: 'http://127.0.0.1:' + receiver.address().port,
  apiKey: 'local-announcement-only', model: original.model, productPrompt: SYSTEM_PROMPT,
  signal: new AbortController().signal, maxBodyBytes: 100000, mcpInstructions: () => snapshot });
const results = [];
try {
  for (const variant of variants) {
    snapshot = variant.snapshot ?? { wiki: WIKI_MCP_INSTRUCTIONS };
    const body = structuredClone(original);
    if (variant.append) body.messages.push({ role: 'user', content: 'explicit offline input state' },
      { role: 'system', content: variant.content });
    else body.messages[1].content = variant.content;
    const saved = JSON.stringify(body);
    const before = received.length;
    const response = await fetch(adapter.baseUrl + '/v1/messages?beta=true', { method: 'POST',
      headers: { 'x-api-key': adapter.apiKey, 'content-type': 'application/json' }, body: saved });
    await response.arrayBuffer();
    assert.equal(response.status, variant.allowed ? 503 : 502, variant.name);
    assert.equal(received.length - before, variant.allowed ? 1 : 0, variant.name);
    assert.equal(JSON.stringify(body), saved);
    if (variant.allowed) {
      const changed = received.at(-1);
      assert.deepEqual(completeHistorySystem(changed, 'in-history', SYSTEM_PROMPT, snapshot), changed);
      assert.deepEqual({ ...changed, messages: body.messages }, body);
      assert.deepEqual(changed.messages.map(message => message.role), body.messages.map(message => message.role));
      body.messages.forEach((message, index) => {
        if (message.role !== 'system') assert.deepEqual(changed.messages[index], message);
        else if (typeof message.content === 'string') assert.ok(changed.messages[index].content.includes(message.content));
        else assert.deepEqual(changed.messages[index].content.slice(-message.content.length), message.content);
      });
      const content = changed.messages.at(-1).content;
      assert.ok(JSON.stringify(content).includes(WIKI_MCP_INSTRUCTIONS));
    }
    results.push({ name: variant.name, passed: true, status: response.status,
      localForwards: received.length - before, inputSha256: createHash('sha256').update(saved).digest('hex') });
  }
} finally {
  await adapter.close(); receiver.closeAllConnections();
  await new Promise((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
}
await assert.rejects(fetch(adapter.baseUrl + '/api/hello', { method: 'HEAD' }));
const report = { scope: 'offline input sequences through actual localhost adapter; no SDK generation',
  results, localReceiverCount: received.length, ownedListenersClosed: true,
  upstreamGeneration: 0, capabilityQueries: 0, jevCalls: 0 };
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report));
