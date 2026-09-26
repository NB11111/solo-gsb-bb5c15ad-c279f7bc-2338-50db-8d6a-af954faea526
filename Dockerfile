FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单并安装，利用构建缓存
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝应用代码
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

# 依赖安装已在构建阶段完成；容器启动即拉起服务，无需额外初始化步骤
CMD ["node", "server.js"]
