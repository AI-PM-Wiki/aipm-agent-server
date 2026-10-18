#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AnnotationReader } from './annotation-reader.ts';
import { createWikiMcpServer } from './tools.ts';
import { WikiIndex } from './search.ts';

const agentRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(agentRoot, '..');
const annotationRoot = join(repoRoot, 'annotation-server');
const evidenceRoot = join(repoRoot, 'meta');
const require = createRequire(import.meta.url);
const tsxEntry = require.resolve('tsx');
const serverEntry = join(annotationRoot, 'src/server.ts');
const siteBase = 'https://aipm.ac';
const article = '/ai/rag/';
const otherArticle = '/ai/agent/';

interface SessionFixture {
  token: string;
  record: {
    tokenHash: string;
    githubId: number;
    login: string;
    createdAt: string;
    expiresAt: string;
    revoked: boolean;
  };
}

interface RunningService {
  base: string;
  apiKey: string;
  stop: () => Promise<string>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function startService(apiKeyEnabled: boolean): Promise<{
  service: RunningService;
  accountA: SessionFixture;
  accountB: SessionFixture;
  expired: SessionFixture;
}> {
  await mkdir(evidenceRoot, { recursive: true });
  const dataDir = await mkdtemp(join(evidenceRoot, 'annotation-read-'));
  const [{ AuthService }, { loadConfig }, { AnnotationStore }] = await Promise.all([
    import(join(annotationRoot, 'src/auth.ts')),
    import(join(annotationRoot, 'src/config.ts')),
    import(join(annotationRoot, 'src/store.ts')),
  ]);
  const store = new AnnotationStore(dataDir);
  const environment = {
    ...process.env,
    DATA_DIR: dataDir,
    SITE_BASE: siteBase,
    GITHUB_CLIENT_ID: 'isolated-read-test',
    GITHUB_CLIENT_SECRET: 'isolated-read-test',
    DEV_AUTH_BYPASS: 'false',
  };
  const accountAuth = new AuthService(loadConfig({ ...environment, SESSION_TTL_MS: '3600000' }), store);
  const accountAToken = accountAuth.issueSession({ githubId: 701001, login: 'read-test-a' });
  const accountBToken = accountAuth.issueSession({ githubId: 701002, login: 'read-test-b' });
  const expiredAuth = new AuthService(loadConfig({ ...environment, SESSION_TTL_MS: '60000' }), store);
  const expiredToken = expiredAuth.issueSession({ githubId: 701003, login: 'read-test-expired' });
  const sessionFor = (token: string): SessionFixture => {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const record = store.sessions.find((session: SessionFixture['record']) => session.tokenHash === tokenHash);
    assert.ok(record);
    return { token, record };
  };
  const accountA = sessionFor(accountAToken);
  const accountB = sessionFor(accountBToken);
  const expired = sessionFor(expiredToken);
  await store.flush();
  await writeFile(join(dataDir, 'store.json'), JSON.stringify({
    version: 1,
    annotations: [],
    sessions: store.sessions,
    operations: [],
  }));

  const port = await freePort();
  const apiKey = apiKeyEnabled ? randomBytes(32).toString('hex') : '';
  const child = spawn(process.execPath, ['--import', tsxEntry, serverEntry], {
    cwd: dataDir,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      SITE_BASE: siteBase,
      DATA_DIR: dataDir,
      SEARCH_INDEX_URL: `${siteBase}/search/search_index.json`,
      GITHUB_CLIENT_ID: 'isolated-read-test',
      GITHUB_CLIENT_SECRET: 'isolated-read-test',
      DEV_AUTH_BYPASS: 'false',
      API_KEY: apiKey,
      JEVE_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stopped = false;
  child.stdout.setEncoding('utf8').on('data', (part: string) => { output += part; });
  child.stderr.setEncoding('utf8').on('data', (part: string) => { output += part; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await rm(dataDir, { recursive: true });
      throw new Error(`隔离批注服务未能启动，退出码 ${child.exitCode}：${output}`);
    }
    try {
      const health = await fetch(`${base}/healthz`);
      if (health.ok) break;
      await delay(150);
    } catch {
      await delay(150);
    }
  }
  const health = await fetch(`${base}/healthz`).catch(() => null);
  if (!health?.ok) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('隔离批注服务未及时退出')), 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    await rm(dataDir, { recursive: true });
    throw new Error(`隔离批注服务未在 30 秒内就绪：${output}`);
  }

  return {
    service: {
      base,
      apiKey,
      stop: async () => {
        if (stopped) return output;
        stopped = true;
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise<void>((resolveExit, reject) => {
            const timer = setTimeout(() => reject(new Error('隔离批注服务未及时退出')), 5_000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolveExit();
            });
          });
        }
        const logs = output;
        await rm(dataDir, { recursive: true });
        return logs;
      },
    },
    accountA,
    accountB,
    expired,
  };
}

function reader(service: RunningService, page: string, token: string | null, apiKey = service.apiKey): AnnotationReader {
  return new AnnotationReader({
    apiBase: service.base,
    apiKey,
    page,
    token,
    signal: AbortSignal.timeout(10_000),
  });
}

function parseResult(text: string): Record<string, unknown> {
  const marker = text.indexOf('\n');
  assert.notEqual(marker, -1);
  return JSON.parse(text.slice(marker + 1)) as Record<string, unknown>;
}

async function callMcpTool(
  annotationReader: AnnotationReader,
  name: 'list_article_annotations' | 'read_annotation_thread',
  args: Record<string, unknown>,
): Promise<string> {
  const config = createWikiMcpServer({
    index: WikiIndex.fromDocs([{ location: 'ai/rag/', title: 'RAG', text: 'RAG 文档' }]),
    proposalPage: article,
    annotationReader,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotation-read-check', version: '1.0.0' });
  await config.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    const listTool = tools.tools.find((tool) => tool.name === 'list_article_annotations');
    const threadTool = tools.tools.find((tool) => tool.name === 'read_annotation_thread');
    assert.ok(listTool && threadTool);
    assert.deepEqual(Object.keys(listTool.inputSchema.properties ?? {}).sort(), ['limit', 'offset']);
    assert.deepEqual(Object.keys(threadTool.inputSchema.properties ?? {}).sort(), [
      'annotation_id', 'reply_limit', 'reply_offset',
    ]);
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    assert.equal(result.isError, false);
    const text = result.content.find((item) => item.type === 'text');
    assert.ok(text && text.type === 'text');
    return text.text;
  } finally {
    await client.close();
    await config.instance.close();
  }
}

async function runMode(apiKeyEnabled: boolean): Promise<void> {
  const started = await startService(apiKeyEnabled);
  const { service, accountA, accountB, expired } = started;
  const baseHeaders = (token: string, includeKey = true): Headers => {
    const headers = new Headers({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    if (includeKey && service.apiKey.length > 0) headers.set('X-API-Key', service.apiKey);
    return headers;
  };
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(new URL(path, service.base), { ...init, headers: init.headers });

  try {
    const publicRead = await request(`/api/annotations?page=${encodeURIComponent(article)}&scope=public`);
    assert.equal(publicRead.status, apiKeyEnabled ? 401 : 200);
    if (apiKeyEnabled) {
      const wrongKey = new Headers({ 'X-API-Key': 'invalid-service-key' });
      const rejected = await request(`/api/annotations?page=${encodeURIComponent(article)}&scope=public`, { headers: wrongKey });
      assert.equal(rejected.status, 401);
      await assert.rejects(reader(service, article, null, 'invalid-service-key').list(0, 10), /HTTP 401/);
    }

    async function createAnnotation(token: string, page: string, body: string, visibility: 'public' | 'private'): Promise<string> {
      const payload = {
        requestId: randomUUID().replace(/-/g, ''),
        page,
        body,
        color: 'yellow',
        visibility,
        target: { scope: 'page', selectors: [] },
      };
      const permitResponse = await request('/api/annotation-permits', {
        method: 'POST',
        headers: baseHeaders(token),
        body: JSON.stringify(payload),
      });
      assert.equal(permitResponse.status, 201, `批注许可请求失败：HTTP ${permitResponse.status}`);
      const permitBody = await permitResponse.json() as { permit: string };
      const headers = baseHeaders(token);
      headers.set('X-Annotation-Permit', permitBody.permit);
      const response = await request('/api/annotations', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 201, `批注创建失败：HTTP ${response.status}`);
      const result = await response.json() as { annotation: { id: string } };
      return result.annotation.id;
    }

    async function createReply(token: string, annotationId: string, body: string): Promise<string> {
      const payload = { annotationId, body };
      const permitResponse = await request('/api/reply-permits', {
        method: 'POST',
        headers: baseHeaders(token),
        body: JSON.stringify(payload),
      });
      assert.equal(permitResponse.status, 201, `回复许可请求失败：HTTP ${permitResponse.status}`);
      const permitBody = await permitResponse.json() as { permit: string };
      const headers = baseHeaders(token);
      headers.set('X-Annotation-Permit', permitBody.permit);
      const response = await request(`/api/annotations/${encodeURIComponent(annotationId)}/replies`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body }),
      });
      assert.equal(response.status, 201, `回复创建失败：HTTP ${response.status}`);
      const result = await response.json() as { annotation: { replies: { id: string }[] } };
      return result.annotation.replies.at(-1)!.id;
    }

    const marker = `read-${randomUUID()}`;
    const publicId = await createAnnotation(accountA.token, article, `${marker}-public`, 'public');
    const privateAId = await createAnnotation(accountA.token, article, `${marker}-private-a`, 'private');
    const privateBId = await createAnnotation(accountB.token, article, `${marker}-private-b`, 'private');
    const otherPageId = await createAnnotation(accountA.token, otherArticle, `${marker}-other-page`, 'public');
    const replyIds: string[] = [];
    for (let index = 0; index < 7; index++) {
      replyIds.push(await createReply(accountA.token, publicId, `${marker}-reply-${index}`));
    }

    const ownerA = parseResult(await callMcpTool(
      reader(service, article, accountA.token),
      'list_article_annotations',
      { offset: 0, limit: 50 },
    ));
    const idsA = (ownerA.annotations as { id: string }[]).map((item) => item.id);
    assert.ok(idsA.includes(publicId) && idsA.includes(privateAId));
    assert.ok(!idsA.includes(privateBId) && !idsA.includes(otherPageId));

    const ownerB = parseResult(await callMcpTool(
      reader(service, article, accountB.token),
      'list_article_annotations',
      { offset: 0, limit: 50 },
    ));
    const idsB = (ownerB.annotations as { id: string }[]).map((item) => item.id);
    assert.ok(idsB.includes(publicId) && idsB.includes(privateBId));
    assert.ok(!idsB.includes(privateAId) && !idsB.includes(otherPageId));

    const anonymous = parseResult(await callMcpTool(
      reader(service, article, null),
      'list_article_annotations',
      { offset: 0, limit: 50 },
    ));
    const anonymousIds = (anonymous.annotations as { id: string }[]).map((item) => item.id);
    assert.ok(anonymousIds.includes(publicId));
    assert.ok(!anonymousIds.includes(privateAId) && !anonymousIds.includes(privateBId));

    const privateForA = await callMcpTool(
      reader(service, article, accountA.token),
      'read_annotation_thread',
      { annotation_id: privateBId, reply_offset: 0, reply_limit: 5 },
    );
    const privateForB = await callMcpTool(
      reader(service, article, accountB.token),
      'read_annotation_thread',
      { annotation_id: privateAId, reply_offset: 0, reply_limit: 5 },
    );
    assert.ok(!privateForA.includes(`${marker}-private-b`));
    assert.ok(!privateForB.includes(`${marker}-private-a`));
    const crossPage = await callMcpTool(
      reader(service, article, accountA.token),
      'read_annotation_thread',
      { annotation_id: otherPageId, reply_offset: 0, reply_limit: 5 },
    );
    assert.ok(!crossPage.includes(`${marker}-other-page`));

    const first = parseResult(await callMcpTool(
      reader(service, article, accountA.token),
      'read_annotation_thread',
      { annotation_id: publicId, reply_offset: 0, reply_limit: 5 },
    ));
    const second = parseResult(await callMcpTool(
      reader(service, article, accountA.token),
      'read_annotation_thread',
      { annotation_id: publicId, reply_offset: 5, reply_limit: 5 },
    ));
    const firstReplies = (first.annotation as { replies: { id: string; body: string }[] }).replies;
    const secondReplies = (second.annotation as { replies: { id: string; body: string }[] }).replies;
    assert.deepEqual(firstReplies.map((reply) => reply.id), replyIds.slice(0, 5));
    assert.deepEqual(secondReplies.map((reply) => reply.id), replyIds.slice(5));
    assert.equal(new Set([...firstReplies, ...secondReplies].map((reply) => reply.id)).size, 7);

    await assert.rejects(reader(service, article, 'invalid-session-token').list(0, 10), /HTTP 401/);
    await delay(Math.max(0, Date.parse(expired.record.expiresAt) - Date.now()) + 25);
    await assert.rejects(reader(service, article, expired.token).list(0, 10), /HTTP 401/);
    await assert.rejects(reader(service, article, expired.token).readThread(publicId, 0, 5), /HTTP 401/);
    const anonymousThread = parseResult(await callMcpTool(
      reader(service, article, null),
      'read_annotation_thread',
      { annotation_id: publicId, reply_offset: 0, reply_limit: 5 },
    ));
    assert.equal((anonymousThread.annotation as { id: string }).id, publicId);
    assert.ok(!JSON.stringify({ ownerA, ownerB, anonymous, first, second }).includes(accountA.token));
    assert.ok(service.apiKey.length === 0 ||
      !JSON.stringify({ ownerA, ownerB, anonymous, first, second }).includes(service.apiKey));

    const logs = await service.stop();
    assert.ok(!logs.includes(accountA.token) && !logs.includes(accountB.token));
    assert.ok(service.apiKey.length === 0 || !logs.includes(service.apiKey));
    console.log(`PASS  API_KEY ${apiKeyEnabled ? '启用' : '未启用'}：匿名、账号 A／B 可见范围与认证失败`);
    console.log('PASS  requestId／一次性许可创建批注与回复；跨文章读取隔离');
    console.log('PASS  回复 5＋2 分页无重复；无效与过期会话失败；凭据未进入结果或日志');
  } finally {
    await service.stop();
  }
}

await runMode(false);
await runMode(true);
