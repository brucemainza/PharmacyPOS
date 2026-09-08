FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8787
EXPOSE 8787

# Migrations are idempotent (CREATE ... IF NOT EXISTS), so re-running them on every container
# start is safe — this is the "seed/migration step" the compose stack needs with zero manual steps.
CMD ["sh", "-c", "npm run migrate && npm start"]
