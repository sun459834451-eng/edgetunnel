FROM node:20-alpine

WORKDIR /app

# 复制依赖配置并安装生产依赖
COPY package.json ./
RUN npm install --omit=dev

# 复制核心脚本及服务端适配器
COPY _worker.js server.mjs ./

# 创建 KV 数据持久化目录
RUN mkdir -p /app/data

ENV PORT=8080 \
    BIND_HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.mjs"]

