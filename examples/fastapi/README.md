# Example: FastAPI + Gravel

A minimal FastAPI app with Gravel mounted at `/admin/ai`.

## Run

```bash
uv sync
cp .env.example .env
# edit .env — DATABASE_URL + OPENAI_API_KEY
uv run python -m artanis_gravel migrate
uv run uvicorn main:app --reload
```

Open http://localhost:8000/admin/ai and sign in with `GRAVEL_ADMIN_PASSWORD` from `.env`.

## Status

This example uses the workspace `artanis-gravel`. End-to-end behaviour
isn't yet wired up; the dashboard route returns a placeholder JSON body
until the v0 SDK lands the full route table.
