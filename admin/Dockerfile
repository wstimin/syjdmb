# Admin
FROM node:20 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts 2>/dev/null || npm install
COPY . .
RUN npm run build

FROM node:20
WORKDIR /app
ENV NODE_ENV=production
ENV BACKEND_INTERNAL_URL=http://localhost:3001
ENV PORT=3002
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3002
CMD ["node", "server.js"]
