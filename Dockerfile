FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_SOURCE=db
ENV ENABLE_LOCAL_REFRESH=false
ENV DASHBOARD_HOST=0.0.0.0
ENV DASHBOARD_PORT=3106

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts/init_db.js ./scripts/init_db.js

EXPOSE 3106
CMD ["sh", "-c", "node scripts/init_db.js && node src/server.js"]
