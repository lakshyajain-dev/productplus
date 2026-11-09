FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/productpulse?schema=public" npm ci

COPY . .
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/productpulse?schema=public" npm run db:generate \
    && npm run build

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
