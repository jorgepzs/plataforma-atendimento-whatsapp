FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data/whatsapp/sessions /data/whatsapp/state && chown -R node:node /data/whatsapp
USER node
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node dist/infra/postgres/migrate.js; fi && node dist/server.js"]

