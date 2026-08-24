/**
 * HTTP 服务(node:http,无框架):
 *  - POST /api/chat  SSE 事件流(ready/sources/delta/done/error + 15s 心跳)
 *  - GET  /healthz   索引状态
 *  - OPTIONS         预检
 * 预校验失败返回纯 JSON:400 / 401(API Key)/ 403(Origin)/ 413(体积)/
 * 429(限流/日预算用尽)/ 503(并发满)。
 * 日志不含原始 IP 与明文 prompt。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { WikiIndex } from './search.ts';
import { runAgent } from './agent.ts';
import type { AgentErrorCode } from './agent.ts';
import { truncateHistory } from './history.ts';
import { SlidingWindowLimiter, Semaphore, SemaphoreError, hashIp } from './rate-limit.ts';
import { DailyBudget } from './budget.ts';
import { initSseResponse, startHeartbeat, writeSseEvent } from './sse.ts';

const ChatBodySchema = z.object({
  message: z.string().min(1).max(10_000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(100_000),
      }),
    )
    .default([]),
});

interface ServerDeps {
  config: Config;
  index: WikiIndex;
}

export function createApp(deps: ServerDeps) {
  const { config, index } = deps;
  const limiter = new SlidingWindowLimiter(
    config.rateLimitMax,
    config.rateLimitWindowMs,
  );
  const semaphore = new Semaphore(config.concurrencyLimit, {
    queueLimit: config.queueLimit,
    waitMs: config.queueWaitMs,
  });
  const budget = new DailyBudget(config.dailyBudgetUsd);
  const startedAt = Date.now();

  function originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true; // 非浏览器请求,无 CORS 约束
    return config.allowedOrigins.includes(origin);
  }

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      // 部署形态不同,真实客户端 IP 所在头不同:
      //   Fly 代理 → fly-client-ip;Cloudflare 隧道(本机 cloudflared)→ cf-connecting-ip
      for (const header of ['fly-client-ip', 'cf-connecting-ip'] as const) {
        const forwarded = req.headers[header];
        if (typeof forwarded === 'string' && forwarded.length > 0) {
          return forwarded.split(',')[0]!.trim();
        }
      }
    }
    const addr = req.socket.remoteAddress;
    return addr === undefined ? 'unknown' : addr;
  }

  /** 常量时间字符串比较(API Key 校验,防时序侧信道;长度不同直接不等)。 */
  function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  function writeJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      ...extraHeaders,
    };
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  function sendError(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    const requestId = req.headers['x-request-id'] ?? randomUUID();
    writeJson(
      res,
      status,
      { error: code, message, requestId },
      extraHeaders, // 真正的 HTTP 头(Retry-After / CORS),不是响应体字段
    );
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    // 响应侧异步写错误(连接销毁后的 EPIPE 类)兜底:有监听则不抛未捕获异常;
    // 断连清理由下方 close 监听负责。
    res.on('error', () => {});
    // 断连取消尽早接线:排队期间客户端关闭也要中止(不占槽位、不写响应)。
    // 注意必须监听响应侧 close 而非 req 的 close——IncomingMessage 'close'
    // 在请求体读完时就触发(Node 语义),监听 req 会把正常请求误判为断连。
    const abortController = new AbortController();
    // 墙钟上限:MAX_RUN_MS 到点强制 abort(与客户端断连同一中止路径),防单轮挂死。
    let runTimer: ReturnType<typeof setTimeout> | null = null;
    let abortedByTimer = false;
    res.once('close', () => {
      if (runTimer !== null) clearTimeout(runTimer);
      if (!res.writableEnded) abortController.abort();
    });
    const origin = req.headers.origin;
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': origin === undefined ? '' : origin,
      Vary: 'Origin',
    };
    if (origin !== undefined && !originAllowed(origin)) {
      sendError(req, res, 403, 'forbidden', 'Origin 不在白名单', corsHeaders);
      return;
    }

    // API Key:仅对无 Origin 请求(curl/脚本/爬虫)强制校验;浏览器请求
    // 已被 Origin 白名单覆盖,不受此限。局限:curl 可伪造 Origin 头绕过,
    // 本层防无差别扫描,针对性攻击由日预算护栏兜底。
    if (config.apiKey && origin === undefined && !safeEqual(req.headers['x-api-key'] ?? '', config.apiKey)) {
      sendError(req, res, 401, 'unauthorized', '缺少或错误的 X-API-Key', corsHeaders);
      return;
    }

    // 日预算护栏:耗尽则全局拒绝(跨日自动重置)。
    if (budget.exhausted) {
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), requestId, event: 'budget_exhausted', spentUsd: budget.spentUsd }),
      );
      const headers = { 'Retry-After': String(24 * 3600), ...corsHeaders };
      sendError(req, res, 429, 'budget_exhausted', '今日问答预算已用完,请明天再试', headers);
      return;
    }

    const ip = clientIp(req);
    const ipKey = hashIp(ip);
    if (!limiter.tryAcquire(ipKey)) {
      const retryAfter = limiter.retryAfterSec();
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), requestId, event: 'rate_limited', ipHash: ipKey.slice(0, 16) }),
      );
      const headers = { 'Retry-After': String(retryAfter), ...corsHeaders };
      sendError(req, res, 429, 'rate_limited', '请求过于频繁,请稍后再试', headers);
      return;
    }

    const acquired = await semaphore.acquire({ signal: abortController.signal }).then(
      (release) => ({ ok: true as const, release }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    if (!acquired.ok) {
      if (acquired.err instanceof SemaphoreError) {
        if (acquired.err.code === 'aborted') return; // 客户端已断开,静默
        const retryAfter = acquired.err.code === 'queue_full' ? '10' : '1';
        const message =
          acquired.err.code === 'queue_full' ? '服务繁忙,请稍后再试' : '排队超时,请稍后再试';
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            requestId,
            event: 'concurrency_limit',
            code: acquired.err.code,
            ipHash: ipKey.slice(0, 16),
          }),
        );
        const headers = { 'Retry-After': retryAfter, ...corsHeaders };
        sendError(req, res, 503, 'concurrency_limit', message, headers);
        return;
      }
      throw acquired.err;
    }
    const release = acquired.release;

    let body = '';
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength > config.bodyLimitBytes) {
      release();
      sendError(req, res, 413, 'payload_too_large', '请求体超限', corsHeaders);
      // 响应已 end,等 flush 后再销毁连接;直接 req.destroy() 会让响应字节丢失
      res.destroySoon();
      return;
    }
    let overLimit = false;
    let bodyTimedOut = false;
    // 慢速 POST 防 DoS:body 读取超时(BODY_TIMEOUT_MS)后 destroy 连接,
    // async 迭代随即抛错进入 catch,释放并发槽位。正常请求毫秒级读完,永不触发。
    const bodyReadTimer = setTimeout(() => {
      bodyTimedOut = true;
      req.destroy();
    }, config.bodyTimeoutMs);
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > config.bodyLimitBytes) {
          overLimit = true;
          break;
        }
      }
      clearTimeout(bodyReadTimer);
    } catch {
      clearTimeout(bodyReadTimer);
      release();
      sendError(
        req,
        res,
        bodyTimedOut ? 408 : 400,
        bodyTimedOut ? 'request_timeout' : 'bad_request',
        bodyTimedOut ? '读取请求体超时' : '读取请求体失败',
        corsHeaders,
      );
      return;
    }
    if (overLimit) {
      release();
      sendError(req, res, 413, 'payload_too_large', '请求体超限', corsHeaders);
      res.destroySoon();
      return;
    }

    let parsed: z.infer<typeof ChatBodySchema> | null = null;
    try {
      parsed = ChatBodySchema.parse(JSON.parse(body));
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      release();
      sendError(req, res, 400, 'bad_request', '请求体格式不正确:需要 {message, history?}', corsHeaders);
      return;
    }

    const history = truncateHistory(parsed.history);

    // —— 进入 SSE 流 ——
    const sseHeaders: Record<string, string> = { ...corsHeaders };
    if (origin === undefined) delete sseHeaders['Access-Control-Allow-Origin'];
    initSseResponse(res, sseHeaders);
    const safeWrite = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        writeSseEvent(res, event, data);
      } catch {
        // 客户端已断开,忽略
      }
    };
    safeWrite('ready', { requestId });
    const stopHeartbeat = startHeartbeat(res);

    let answerChars = 0;
    let thinkingChars = 0;
    let sourcesCount = 0;
    const log = (extra: Record<string, unknown>) =>
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), requestId, ...extra }),
      );

    // 墙钟上限:MAX_RUN_MS 到点 abort,防止单轮 agent 挂死(客户端断连也走同一
    // abort 路径,靠 abortedByTimer 区分来源)。
    runTimer = setTimeout(() => {
      abortedByTimer = true;
      abortController.abort();
    }, config.maxRunMs);
    runTimer.unref();
    const outcome = await runAgent({
      message: parsed.message,
      history,
      config,
      index,
      signal: abortController.signal,
      callbacks: {
        onDelta: (text) => {
          answerChars += text.length;
          safeWrite('delta', { text });
        },
        onThinking: (text) => {
          thinkingChars += text.length; // 只计数标记,不渲染
        },
        onSources: (evt) => {
          sourcesCount++;
          safeWrite('sources', {
            query: evt.query,
            results: evt.results.map(({ title, url, snippet }) => ({
              title,
              url,
              snippet,
            })),
          });
        },
        onStderr: (line) => log({ event: 'sdk_stderr', line: line.slice(0, 500) }),
      },
    });
    if (runTimer !== null) {
      clearTimeout(runTimer);
      runTimer = null;
    }
    stopHeartbeat();
    if (outcome.costUsd) budget.track(outcome.costUsd);

    const timedOut = abortedByTimer;
    const closedByClient = abortController.signal.aborted && !timedOut;
    if (!closedByClient) {
      if (outcome.ok) {
        safeWrite('done', {
          usage: outcome.usage,
          costUsd: outcome.costUsd,
          durationMs: outcome.durationMs,
          numTurns: outcome.numTurns,
        });
        log({ event: 'done', ok: true, costUsd: outcome.costUsd, durationMs: outcome.durationMs, numTurns: outcome.numTurns, answerChars, thinkingChars, sourcesCount, dailyLeftUsd: budget.remainingUsd });
      } else if (timedOut) {
        // 墙钟超时:与客户端断连区分,给客户端明确的 error 帧
        safeWrite('error', { code: 'internal', message: '处理超时,请稍后重试' });
        log({ event: 'run_timeout', durationMs: outcome.durationMs, answerChars, thinkingChars });
      } else {
        const code: AgentErrorCode = outcome.code ?? 'internal';
        const message = outcome.message ?? '未知错误';
        safeWrite('error', { code, message });
        // message 可能含 SDK 异常/prompt 片段,日志只留前 200 字(承诺:日志不含明文 prompt)
        log({ event: 'error', code, message: message.slice(0, 200), costUsd: outcome.costUsd, durationMs: outcome.durationMs });
      }
      if (!res.writableEnded) res.end();
    } else {
      log({ event: 'aborted_by_client', answerChars, thinkingChars });
      if (!res.writableEnded) res.end();
    }
    release();
  }

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0]!;
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      if (!originAllowed(req.headers.origin)) {
        sendError(req, res, 403, 'forbidden', 'Origin 不在白名单');
        return;
      }
      const headers: Record<string, string> = { Vary: 'Origin', 'Content-Length': '0' };
      if (req.headers.origin !== undefined) {
        headers['Access-Control-Allow-Origin'] = req.headers.origin;
        headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type';
        headers['Access-Control-Max-Age'] = '86400';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/healthz') {
      const stats = index.getStats();
      writeJson(res, 200, {
        ok: true,
        indexDocs: stats.docCount,
        stale: stats.stale,
        lastIndexLoadedAt: stats.lastLoadedAt,
        lastIndexError: stats.lastError,
        concurrencyActive: semaphore.activeCount,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
      return;
    }

    if (method === 'POST' && path === '/api/chat') {
      void handleChat(req, res).catch((err) => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'handler_crash',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        try {
          res.destroy();
        } catch {
          // 连接已不可用
        }
      });
      return;
    }

    sendError(req, res, 404, 'not_found', 'Not Found');
  });

  return { server, limiter, semaphore };
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig(); // 缺 ANTHROPIC_API_KEY 等必填项 → 抛错,启动快速失败
  const index = new WikiIndex(
    config.searchIndexUrl,
    config.indexRefreshMs,
    config.siteBase,
  );
  console.log(`[server] 加载站内索引: ${config.searchIndexUrl}`);
  await index.load(); // 首次加载失败 → 启动失败
  index.startAutoRefresh();

  const { server } = createApp({ config, index });
  server.listen(config.port, config.host, () => {
    console.log(
      `[server] 就绪: http://${config.host}:${config.port}  ` +
        `(docs=${index.getStats().docCount}, model=${config.model}, ` +
        `maxBudget=$ ${config.maxBudgetUsd}, maxTurns=${config.maxTurns})`,
    );
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    index.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('server.ts') || entry.endsWith('dist/server.js')) {
  void main().catch((err) => {
    console.error(`[server] 启动失败: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
