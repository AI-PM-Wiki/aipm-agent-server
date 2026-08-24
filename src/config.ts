/**
 * 环境变量解析与校验。
 * 缺 ANTHROPIC_API_KEY 时快速失败(zod parse 抛错,启动即退出)。
 * .env 的加载由入口模块(server.ts / cli.ts)负责,这里保持纯净、可单测。
 */
import { z } from 'zod';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Config {
  port: number;
  host: string;
  anthropicApiKey: string;
  model: string;
  effort: EffortLevel;
  maxBudgetUsd: number;
  maxTurns: number;
  siteBase: string;
  searchIndexUrl: string;
  indexRefreshMs: number;
  allowedOrigins: string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  concurrencyLimit: number;
  queueLimit: number;
  queueWaitMs: number;
  apiKey: string;
  dailyBudgetUsd: number;
  bodyLimitBytes: number;
  bodyTimeoutMs: number;
  maxRunMs: number;
  trustProxy: boolean;
  trustedProxyIps: string[];
  scratchDir: string;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // 绑定地址:默认仅回环 127.0.0.1(bare npm start 不暴露公网);公网暴露需显式 0.0.0.0。
  HOST: z.string().min(1).default('127.0.0.1'),
  ANTHROPIC_API_KEY: z.string().min(1),
  MODEL: z.string().min(1).default('claude-opus-5'),
  EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  MAX_BUDGET_USD: z.coerce.number().positive().default(0.3),
  MAX_TURNS: z.coerce.number().int().min(1).max(100).default(8),
  SITE_BASE: z.string().url().default('https://aipm.ac'),
  SEARCH_INDEX_URL: z
    .string()
    .url()
    .default('https://aipm.ac/search/search_index.json'),
  INDEX_REFRESH_MS: z.coerce.number().int().min(10_000).default(1_800_000),
  ALLOWED_ORIGINS: z
    .string()
    .default('https://aipm.ac,http://localhost:8000,http://127.0.0.1:8000'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(600_000),
  CONCURRENCY_LIMIT: z.coerce.number().int().min(1).max(64).default(4),
  QUEUE_LIMIT: z.coerce.number().int().min(0).max(256).default(10),
  QUEUE_WAIT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  // 无 Origin 请求(curl/脚本)须携带 X-API-Key;留空 = 不校验。
  // 浏览器请求由 Origin 白名单覆盖,不受此限。
  API_KEY: z.string().default(''),
  // 每日预算护栏(USD,按 SDK total_cost_usd 累计,UTC 日切,进程内状态):
  // 0 = 关闭;默认 1.4 ≈ ¥10/天(以实际账单为准可调)。
  DAILY_BUDGET_USD: z.coerce.number().min(0).default(1.4),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(65_536),
  // 请求体读取超时(ms):慢速 POST 拖住并发槽位的 DoS 兜底,超时断开并释放槽位。
  BODY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  // 单轮问答墙钟上限(ms):到点强制 abort(与客户端断连同一中止路径),防 agent 挂死。
  MAX_RUN_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  TRUST_PROXY: z.string().default('false'),
  // 可信代理 IP 列表(逗号分隔):仅当 TRUST_PROXY=true 且连接来自这些地址
  // 时才读取 Fly-Client-IP / cf-connecting-ip 转发头;否则忽略转发头,防止
  // 伪造头绕过每 IP 限流。默认仅回环(含 IPv6 形态 ::ffff:127.0.0.1)。
  TRUSTED_PROXY_IPS: z.string().default('127.0.0.1,::1,::ffff:127.0.0.1'),
  SCRATCH_DIR: z.string().min(1).default('/tmp/aipm-agent-scratch'),
});

function parseBool(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`环境变量校验失败: ${problems}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    model: e.MODEL,
    effort: e.EFFORT,
    maxBudgetUsd: e.MAX_BUDGET_USD,
    maxTurns: e.MAX_TURNS,
    siteBase: e.SITE_BASE.replace(/\/+$/, ''),
    searchIndexUrl: e.SEARCH_INDEX_URL,
    indexRefreshMs: e.INDEX_REFRESH_MS,
    allowedOrigins: e.ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    rateLimitMax: e.RATE_LIMIT_MAX,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    concurrencyLimit: e.CONCURRENCY_LIMIT,
    queueLimit: e.QUEUE_LIMIT,
    queueWaitMs: e.QUEUE_WAIT_MS,
    apiKey: e.API_KEY,
    dailyBudgetUsd: e.DAILY_BUDGET_USD,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    bodyTimeoutMs: e.BODY_TIMEOUT_MS,
    maxRunMs: e.MAX_RUN_MS,
    trustProxy: parseBool(e.TRUST_PROXY),
    trustedProxyIps: e.TRUSTED_PROXY_IPS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    scratchDir: e.SCRATCH_DIR,
  };
}
