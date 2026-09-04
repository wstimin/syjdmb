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
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
RUN npx prisma generate
EXPOSE 3001
CMD ["node", "dist/main.js"]
