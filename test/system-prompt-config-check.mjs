import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildAgentOptions } from '../dist/agent.js';
import { loadConfig } from '../dist/config.js';
import { WikiIndex } from '../dist/search.js';

const scratch = process.argv[2];
assert.ok(scratch);
const config = loadConfig({ ANTHROPIC_API_KEY: 'local-config-only', SCRATCH_DIR: scratch });
const index = WikiIndex.fromDocs([], 'http://127.0.0.1:8000');
const built = buildAgentOptions({ config, index, callbacks: {
  onDelta() { assert.fail('unexpected_response'); }, onThinking() { assert.fail('unexpected_response'); },
} });
const client = new Client({ name: 'configuration-check', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = built.options.mcpServers.wiki.instance;
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal(client.getInstructions(), built.mcpInstructions.wiki);
  assert.ok(Object.isFrozen(built.mcpInstructions));
  const second = buildAgentOptions({ config, index, callbacks: {} });
  assert.notEqual(second.mcpInstructions, built.mcpInstructions);
  assert.notEqual(second.options.mcpServers.wiki.instance, server);
  assert.deepEqual(second.mcpInstructions, built.mcpInstructions);
  await second.options.mcpServers.wiki.instance.close();
  console.log(JSON.stringify({ passed: true, realMcpInitialize: true, snapshotMatchesSdkInstructions: true,
    independentSessionConfiguration: true, toolCalls: 0, upstreamRequests: 0 }));
} finally { await client.close(); await server.close(); index.stop(); }
