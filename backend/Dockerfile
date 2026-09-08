# Backend
FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts 2>/dev/null || npm install
COPY tsconfig.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
RUN npm run build

FROM node:20
WORKDIR /app
ARG GIT_HASH=unknown
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
RUN npx prisma generate
# 记录构建来源提交，供部署脚本做「代码/镜像一致性」校验
RUN echo "$GIT_HASH" > /app/.git-hash
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
