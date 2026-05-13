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

## What you'll see

Once running, `/admin/ai` serves the real React dashboard:

- Login screen on first visit (password from `.env`'s `GRAVEL_ADMIN_PASSWORD`); `localhost` is auto-admin so you can iterate without logging in.
- Samples tab populates as your app's OpenAI / Anthropic / LangChain / Vercel-AI / `fetch` calls are auto-traced.
- Prompts tab lists every prompt the wizard's manifest scan picked up; click one to open the editor, save drafts to localStorage, submit as a PR via the Gravel GitHub App.
- Update banner fires when a newer `artanis-gravel` is on PyPI; pending-migrations banner fires when bundled Alembic revisions land that haven't been applied.
