# AI-PM Agent Server

[AI-PM Wiki](https://aipm.ac)的文档问答 Agent 后端。纯静态 wiki 之上的一层问答服务:
BM25 站内检索 + Claude Agent SDK 驱动回答,SSE 流式输出。

## 架构

```
POST /api/chat ──► server.ts (node:http 路由/CORS/限流/并发)
                      │  SSE: ready → sources* → delta* → done | error
                      ▼
                  agent.ts (runAgent: query() 生成器,块索引增量 diff)
                      │  mcpServers: { wiki } 进程内 MCP,strictMcpConfig
                      ▼
                  tools.ts (search_wiki / read_wiki_page)
                      ▼
                  search.ts (search_index.json 抓取+30min 刷新 / 中文分词 / BM25)
```

- 检索只依赖线上 `search_index.json`(mkdocs 官方搜索索引),**不发活 HTML 请求**;
  索引加载失败即启动失败,后台刷新失败则保留旧索引并在 `/healthz` 标记 `stale`。
- 中文分词:归一化 → 拉丁/数字 token → CJK 连续段 unigram + 字符 bigram
  (「提示词工程」→ 提/示/词/工/程/提示/示词/词工/工程);BM25(k1=1.5, b=0.75, tf 上限 3)。
- 召回质量(2026-08-24 实测调优,零依赖、纯数据驱动):
  - 索引侧:标题 token ×3 并入正文——「RAG」「提示词工程」这类专名页靠标题命中
    顶格召回(「什么是 RAG」从 top-8 外 → 正典页第一);
  - 查询侧:df 占比 >40% 的单字(是/的/了…虚词)剔除;二字 token 若 df>40% 或由
    两个 df>30% 的超高频单字组成(什么/么是/是什/怎么 这类虚词组合)同样剔除——
    「什么是 X」不再被标题命中的虚词组合反杀;但构成单字虽高频、自身却极稀见
    (df≤10 篇文档)的二字 token 视为专名/特有短语候选(实测「会计」df=4 曾被
    误删,查询只剩单字「会」),无条件保留。全部被剔除时回退原 token。
- 工具面:`tools: []` 禁用全部内置工具,只剩 `mcp__wiki__search_wiki` / `mcp__wiki__read_wiki_page`;
  `disallowedTools` 列 9 项内置工具纵深防御;`strictMcpConfig` + `settingSources: []` 隔离宿主配置。
- SDK 子进程工作目录指向空 scratch 目录(`SCRATCH_DIR`),`persistSession: false`。

## 配置

复制 `.env.example` 为 `.env` 后填写。关键项:

| 键 | 说明 |
|---|---|
| `PORT` / `HOST` | 监听端口(默认 8787)与绑定地址(默认 `127.0.0.1`,仅回环;公网暴露需显式 `0.0.0.0` 并自备防护) |
| `ANTHROPIC_API_KEY` | 必填,缺失时启动快速失败 |
| `SITE_BASE` | 站点根(默认 `https://aipm.ac`),检索结果与页面链接的拼接基址 |
| `MODEL` / `EFFORT` / `MAX_BUDGET_USD` / `MAX_TURNS` | SDK 会话参数(预算与轮数由 SDK 强制) |
| `SEARCH_INDEX_URL` / `INDEX_REFRESH_MS` | 索引地址与后台刷新间隔(默认 30 分钟) |
| `ALLOWED_ORIGINS` | 精确 Origin 白名单,逗号分隔,无通配符、无凭据 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` / `CONCURRENCY_LIMIT` | 每 IP 滑动窗口限流 + 并发信号量(成本护栏) |
| `QUEUE_LIMIT` / `QUEUE_WAIT_MS` | 并发满时排队深度(默认 10)与等待上限(默认 60s),超限 503 + Retry-After |
| `API_KEY` | **无 Origin 请求**(curl/脚本/爬虫)须携带 `X-API-Key` 头,否则 401;留空 = 不校验。浏览器请求由 Origin 白名单覆盖,不受此限。局限:curl 可伪造 Origin 头绕过,本层防无差别扫描,针对性攻击由日预算兜底 |
| `DAILY_BUDGET_USD` | 每日预算护栏(USD,按 SDK `total_cost_usd` 累计,UTC 日切,进程内状态,重启清零):耗尽后全局拒绝 429 `budget_exhausted`「今日问答预算已用完,请明天再试」,次日自动恢复;`0` = 关闭。**预占-结算**:请求先原子预占单轮上限(`MAX_BUDGET_USD`),执行后按实际成本结算,并发/失败路径自动释放——不会因「先检查后记账」的竞态窗口超支。默认 `1.4` ≈ ¥10/天(以实际账单为准可调) |
| `BODY_LIMIT_BYTES` / `BODY_TIMEOUT_MS` | 请求体上限(默认 64 KiB,超限 413)与读取超时(默认 15s,慢速 POST 防 DoS) |
| `MAX_RUN_MS` | 单轮问答墙钟上限(默认 120s):到点强制中止(SSE `error` 帧,code `internal`),防 agent 挂死 |
| `SCRATCH_DIR` | SDK 子进程工作目录(默认 `/tmp/aipm-agent-scratch`) |
| `TRUST_PROXY` | 置 `true` **且直连来源属于 `TRUSTED_PROXY_IPS`(默认回环)** 时,才从 `Fly-Client-IP` / `cf-connecting-ip` 取客户端 IP;否则忽略转发头、回落 socket 地址。直连暴露(`HOST=0.0.0.0`)时不会信任任意来源的伪造转发头,每 IP 限流无法被绕过 |
| `TRUSTED_PROXY_IPS` | 可信代理 IP 列表,逗号分隔(默认 `127.0.0.1,::1,::ffff:127.0.0.1`):仅当 `TRUST_PROXY=true` 且连接来自这些地址时才读取转发头 |

## 开发与运行

```bash
npm install          # 装依赖(含 SDK 自带 CLI 原生二进制)
npm run build        # tsc → dist/
npm start            # 起服务,监听 HOST:PORT(默认 127.0.0.1:8787)
npm run smoke        # 检索冒烟:BM25 top-5 目检(零依赖,也可 node src/smoke-search.ts)
npm run unit-check   # 无依赖单元检查(分词/BM25/定位/限流等,需网络访问线上索引)
npm run cli -- --check-config   # 无 key 断言工具面配置组装正确
npm run cli -- --prompt "什么是 RAG?"   # 真跑一轮 agent
```

健康检查:`curl http://127.0.0.1:8787/healthz` → `{ok, indexDocs, stale, ...}`。

SSE 协议(事件流,15s 心跳注释行 `: ping`):

| event | data | 时机 |
|---|---|---|
| `ready` | `{requestId}` | 流打开 |
| `sources` | `{query, results:[{title,url,snippet}]}` | 每次 search_wiki 返回 |
| `delta` | `{text}` 增量 | 回答 token 块 |
| `done` | `{usage, costUsd, durationMs, numTurns}` | 终帧后关闭 |
| `error` | `{code: budget_exceeded\|max_turns\|model_error\|internal, message}` | 随后关闭 |

预校验失败(400/401/403/408/413/429/503)返回纯 JSON,非 SSE;其中 429 的
`code` 为 `rate_limited` / `budget_exhausted`(JSON 码,不是流内事件)。流内
`error` 帧只有上表 4 个 code(墙钟超时 `MAX_RUN_MS` 也走 `internal` 帧)。
客户端断连即 abort,停止计费。

## 部署注意

- **单实例假设**:限流、并发信号量与日预算护栏(已消耗 + 预占)都是进程内
  状态,横向扩容需改为共享存储(Redis 等);并发上限 4 对应 SDK 子进程数,
  实例数 × 4 为总并发。并发满时
  请求进入有界队列(`QUEUE_LIMIT`/`QUEUE_WAIT_MS`),不排队失败——这是成本
  护栏而非性能瓶颈:每个槽位背后是实打实的 LLM 调用,宁可让用户稍等也不可
  无上限并发烧穿月度预算。
- **索引刷新滞后**:内容更新后最多 `INDEX_REFRESH_MS`(默认 30 分钟)才会被问答读到;
  刷新失败不重启,`/healthz` 的 `stale` 标记可见。
- 日志不含原始 IP 与明文 prompt(限流事件只记 IP 的 sha256 前缀)。
- 首次启动需要能访问 `SEARCH_INDEX_URL`;SDK 需要能访问 Anthropic API(或配置代理)。

## 部署(Docker Compose + 系统级 Cloudflare 隧道)

仓库自带 `Dockerfile` + `docker-compose.yml`(单容器 agent-server;HTTPS/域名
由 VPS **系统级 cloudflared** 隧道承担,不再内置 cloudflared 容器):

```bash
# VPS 上:装 docker + compose 插件;拉取或拷贝本仓库
cd agent-server
cp .env.example .env          # 填 ANTHROPIC_API_KEY(隧道 token 由系统级 cloudflared 负责)
docker compose up -d --build
```

- **HTTPS/域名**:Cloudflare Zero Trust → Networks → Tunnels 建隧道;隧道由
  VPS 上系统级 cloudflared 运行(如 ai-gateway 隧道,ingress 配置在
  `/etc/cloudflared/config.yml`),public hostname 配 `docs-agent.nvc.ac` →
  `http://127.0.0.1:8787`(compose 绑定的宿主回环端口)。HTTPS 由 Cloudflare
  边缘终止,证书自动;`docs-agent.nvc.ac` 域名在 Cloudflare 侧托管。
- **端口**:compose 只绑 `127.0.0.1:8787`,公网不暴露任何端口;DDoS/缓存归
  Cloudflare 管。
- **HOST(容器内)**:`.env` 需设 `HOST=0.0.0.0`——server 默认 `127.0.0.1`,容器
  内只监听自身回环,宿主映射(compose 的 `127.0.0.1:8787`)会连接被拒(healthz
  在容器内健康但外部 502/连接重置)。`0.0.0.0` 仅指容器内;宿主仍只回环暴露,
  公网不可直接达。
- **限流**:`.env` 的 `TRUST_PROXY=true` 必须保持——隧道下所有请求从本机
  cloudflared 进入,真实客户端 IP 在 `cf-connecting-ip` 头(server.ts 的
  clientIp 同时支持 fly-client-ip 与 cf-connecting-ip),否则限流全打在
  127.0.0.1 上失效。
- **成本护栏是进程内状态**:单实例假设,限流/并发信号量与日预算(预占-结算)
  随实例走,多实例时总日预算 = 实例数 × `DAILY_BUDGET_USD`,扩容需改共享
  存储(Redis 等);并发上限 4 对应 SDK 子进程数。
- 验证:`curl https://docs-agent.nvc.ac/healthz` → `{ok, indexDocs, stale, ...}`。
