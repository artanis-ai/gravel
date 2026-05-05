# Example: Next.js (App Router) + Gravel

A minimal Next.js 15 App Router app with Gravel installed. Demonstrates:

- `app/admin/ai/[[...slug]]/route.ts` mounting the dashboard.
- `gravel.config.ts` with default-password auth (replace with `getUser` for production).
- A trivial OpenAI call that produces a trace once auto-patches land in v1.

## Run

```bash
pnpm install
cp .env.example .env.local
# edit .env.local — at minimum set DATABASE_URL and OPENAI_API_KEY
pnpm exec gravel migrate     # idempotent CREATE TABLEs
pnpm dev
```

Open http://localhost:3000/admin/ai and log in with the password from `.env.local`.

## Status

This example uses the unpublished `@artanis-ai/gravel` from the workspace; it won't run end-to-end until the lib reaches usable v0. The `gravel.config.ts` and `route.ts` files are real and reflect the eventual API.
