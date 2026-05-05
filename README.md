# Gravel

> Open-source library that mounts an admin dashboard inside your AI app. Domain experts review output, manage prompts, and run evals — without ever touching your codebase.

**Status: pre-v0. Skeleton in progress.** Not yet usable. See [`STATUS.md`](STATUS.md) for what's built and what's next, and [`docs/roadmap.md`](https://github.com/artanis-ai/gravel-cloud/blob/main/docs/roadmap.md) (private) for the full plan.

```bash
# What this will do once v0 ships:
npx @artanis/gravel init
```

## What it is

Gravel is a library you install into your existing AI engineering codebase (TypeScript or Python). Once installed, an admin dashboard mounts inside your app at `/admin/ai`. From there, your **domain experts** — clinicians, lawyers, teachers, recruiters, accountants, whoever — can:

- See every prompt in the codebase, edit it, and submit a GitHub PR for the change.
- Review LLM traces flowing through your pipeline, leave feedback and corrections.
- Build datasets from labelled traces and run evals against them.

Where Langfuse / LangSmith pitch dashboards to engineers, **Gravel ships a dashboard for the people whose job *isn't* engineering** — the ones who actually know what good looks like in your domain.

## What's open-source

This repo is the embedded library. It's Apache 2.0. You can audit every line, fork it, run it.

The judge service it talks to for paid evals is closed-source and lives elsewhere. That's the only thing not in this repo. Tracing data and prompts always stay in your own database; only rows being judged ever leave your infrastructure.

## Repo layout

```
gravel/
├── packages/sdk-ts/        # @artanis/gravel — TypeScript SDK + bundled dashboard + wizard
├── packages/dashboard/     # React app shipped inside the SDKs
├── python/gravel/          # artanis-gravel — Python SDK + bundled dashboard + wizard
├── apps/docs/              # Mintlify docs → gravel.artanis.ai
├── examples/               # Next.js, FastAPI, Django integration examples
└── .github/workflows/      # CI: lint, test, schema-drift checks
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The product spec lives in the private `gravel-cloud` repo (Artanis-internal); the architecture overview applicable to OSS contributors is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## License

Apache 2.0. See [`LICENSE`](LICENSE).
