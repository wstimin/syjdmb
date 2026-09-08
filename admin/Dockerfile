# Admin
FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts 2>/dev/null || npm install
COPY . .
RUN npm run build

FROM node:20
WORKDIR /app
ARG GIT_HASH=unknown
ENV NODE_ENV=production
ENV BACKEND_INTERNAL_URL=http://localhost:3001
ENV PORT=3002
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 记录构建来源提交，供部署脚本做「代码/镜像一致性」校验
RUN echo "$GIT_HASH" > /app/.git-hash
EXPOSE 3002
CMD ["node", "server.js"]
