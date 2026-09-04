# Frontend
FROM node:20 AS builder
WORKDIR /app
# BACKEND_INTERNAL_URL 在运行时由 middleware 使用，不需要 build 时设置
COPY package*.json ./
RUN npm install --ignore-scripts 2>/dev/null || npm install
COPY . .
RUN npm run build

FROM node:20
WORKDIR /app
ENV NODE_ENV=production
ENV BACKEND_INTERNAL_URL=http://localhost:3001
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
