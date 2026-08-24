# AI-PM Agent Server 运行镜像(docker compose 部署用,见 docker-compose.yml)。
# 两阶段:构建阶段 npm ci + tsc 出 dist;运行阶段只带生产依赖与产物。
# 基础镜像选 node:22-slim(Debian/glibc)——Agent SDK 的 CLI 原生二进制
# 按平台走 optionalDependencies,glibc 环境兼容性最稳,勿换 alpine。
#
# 运行所需环境变量(部署时经 .env 注入,见 README「部署」):
#   ANTHROPIC_API_KEY(必填) / SEARCH_INDEX_URL / ALLOWED_ORIGINS / TRUST_PROXY ...

# ---- 构建 ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- 运行 ----
FROM node:22-slim
# 镜像版本与 package.json 保持同步(compose 的 image tag 用同版本,如 aipm-agent-server:0.1.0)
ARG VERSION=0.1.0
LABEL org.opencontainers.image.version=$VERSION
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=8787
EXPOSE 8787
# start_period 45s:首次启动需下载并分词索引,最坏 30s(fetch 超时)+ 余量
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/server.js"]
