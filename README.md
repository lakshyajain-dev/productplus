# ProductPulse

ProductPulse is a dark customer feedback intelligence workspace built with React, TypeScript, Vite, Express, Prisma, PostgreSQL, Groq, and Hindsight.

## What is included

- Eight product pages: Overview, Feedback Inbox, Emerging Issues, AI Insights, Memory Explorer, Product Updates, Impact Tracker, and Settings.
- Seeded sample workspace with 60 feedback records, six issue groups, five example insights, and four product updates.
- Search, filtering, CSV import/export, manual classification corrections, review status, issue status changes, issue merge/split, update tracking, and before/after impact analysis.
- Server-side Groq classification and evidence-grounded explanation routes. If Groq is not configured or returns invalid output, the API uses its local rule-based classifier and clearly reports the connection state in Settings.
- Hindsight retain, recall, and reflect operations for customer feedback, issues, and released product updates. Without credentials, memory remains pending/not configured and the UI does not claim that Hindsight returned results.
- PostgreSQL-backed persistence and a Prisma migration/seed. Without a reachable database, the API starts with demo records in process memory.
- Responsive desktop and mobile layouts, keyboard shortcuts, command search, and a contextual assistant.

## Requirements

- Node.js 20.19+ or 22.12+ (Node.js 26 is also supported by the current toolchain)
- npm 10+
- PostgreSQL 15+ for database-backed persistence
- Optional: a Groq API key and a Hindsight service URL, API key, and bank ID

## Run locally

```bash
npm ci
cp .env.example .env
```

Edit `.env` and set `DATABASE_URL` to a database you can reach. Create the database before applying the migration, then run:

```bash
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

The Vite client runs at `http://localhost:5173`; the Express API runs at `http://localhost:4000`. `npm run build` creates the production client bundle, and `npm start` serves the API and the built client from port 4000.

### Vercel + Render staging

The frontend deploys to Vercel as a Vite static site. The Vercel function in `api/` proxies `/api/*` requests to Render and adds a server-side shared secret. The Render API rejects requests without that secret (except its health check). Set the same `PRODUCTPULSE_PROXY_SECRET` in Vercel Preview and Render, and set `RENDER_API_ORIGIN` in Vercel to the Render service's HTTPS origin. Do not prefix either value with `VITE_`.

`render.yaml` defines a Render API service and a separate Render Postgres database. Render applies Prisma migrations before the API starts and seeds the synthetic sample workspace once on first deployment. The Blueprint uses free plans for staging; Render's free Postgres databases expire after 30 days and do not include backups, so use a paid database before keeping important data there. See [Render's free-instance limits](https://render.com/docs/free).

For private staging, deploy a Vercel Preview deployment and enable **Vercel Authentication** under **Project Settings → Deployment Protection**. Render's API service remains internet reachable, but its data routes require the proxy secret. The staging database contains synthetic data only. The checked-in Vercel and Render Blueprint setup uses Git-based deployments, so push this project to a Git repository and connect that repository to both providers.

The `Dockerfile` excludes `.env`, installs OpenSSL for Prisma, builds the frontend, and applies migrations before starting the API. Do not copy local secrets into a container image.

### Demo mode without PostgreSQL

The client and API can run without a database. Remove `DATABASE_URL` from `.env` (or leave it unset), then start with `npm run dev`. The server loads the bundled sample workspace into memory. Changes made in that API session are not durable across server restarts. The browser-only fallback stores a small subset of edits in local storage if the API is unavailable.

### Optional AI and memory services

Set these only in the server environment; never expose service keys through `VITE_*` variables:

```dotenv
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-120b
HINDSIGHT_API_URL=https://api.hindsight.vectorize.io
HINDSIGHT_API_KEY=...
HINDSIGHT_BANK_ID=ProductPulse
```

The Groq integration uses the OpenAI-compatible chat completions endpoint with JSON output. The default model is `openai/gpt-oss-120b`: Groq lists it as a production model and documents JSON Object Mode. The previous `llama-3.3-70b-versatile` default was deprecated for free and developer plans on August 16, 2026. Groq also lists `openai/gpt-oss-20b` as a faster, lower-cost production option. See the [supported model catalog](https://console.groq.com/docs/models), [GPT-OSS 120B capabilities](https://console.groq.com/docs/model/openai/gpt-oss-120b), and [deprecation schedule](https://console.groq.com/docs/deprecations). Hindsight uses the official TypeScript client; see the [Hindsight TypeScript SDK guide](https://docs.hindsight.vectorize.io/enterprise/typescript-sdk/). Use the Settings page’s **Verify integrations** button to check configured services. Hindsight is not simulated: when it is unavailable, the app labels memory as not configured or unavailable and does not show fabricated retrieval results.

## Tests and build checks

```bash
npm test
npm run build
npx prisma validate
```

The API tests run without external credentials. The Groq and Hindsight integration checks are skipped unless their environment variables are present; when enabled, they make real service requests. The Hindsight test retains a synthetic verification note in the configured bank.

## API surface

The Express API is rooted at `/api`:

- `GET /health`, `GET /health/integrations`
- `GET /dashboard/overview`, `GET /dashboard/trends`, `GET /dashboard/sentiment`
- `GET /feedback`, `POST /feedback`, `GET /feedback/:id`, `PATCH /feedback/:id`, `GET /feedback/facets`, `POST /feedback/import`, `GET /feedback/export`
- `GET /issues`, `POST /issues`, `GET /issues/:id`, `PATCH /issues/:id`, and issue merge/split actions
- `GET /insights`, `POST /insights/generate`
- `GET /memory/status`, `GET /memory/recent`, `POST /memory/sync`, `POST /memory/recall`, `POST /memory/reflect`
- `GET /product-updates`, `POST /product-updates`, `GET /product-updates/:id`, `PATCH /product-updates/:id`
- `GET /impact`, `POST /impact/analyze`, `POST /assistant/chat`
- `GET /settings/workspace`, `PATCH /settings/workspace`

All impact comparisons include a correlation-versus-causation note. They report record counts around a release date and do not establish that a release caused a change.

## Data and deployment notes

The Prisma schema and initial SQL migration are in `prisma/`. The seed script creates a sample workspace and its associated records. Sample records are marked as demo data. The current app is a single-workspace local product scaffold: authentication, user invitations, tenant isolation, and production deployment configuration are not included. Add those before exposing a deployed instance to untrusted users.

This workspace is a standard local project. The session did not expose a Google AI Studio Build project, managed database, or secret manager, so none is assumed or represented as provisioned. Configure PostgreSQL, Groq, and Hindsight in the runtime where this project will be deployed.
