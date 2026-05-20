# Gravel

> Open-source library that mounts an admin dashboard inside your AI app. Domain experts review output, manage prompts, and run evals, without ever touching your codebase.

**Status: v0.9.x, live on npm + PyPI.** Wizard installs against the production `gravel.artanis.ai` control plane. Default-password auth, manifest-backed prompts (list + detail + submit-as-PR via the `gravel[bot]` GitHub App with atomic manifest rewrite), tracing auto-patches (OpenAI / Anthropic / Gemini / LangChain / Vercel AI / generic `fetch`), the judge + eval runner, and the bundled React dashboard all ship. Six TypeScript framework integrations (Next.js App + Pages routers, Express, Hono, Fastify, generic Node) and five Python integrations (FastAPI, Django, Flask, raw ASGI, raw WSGI), all delegating to one shared dispatcher for byte-equal cross-stack behaviour. Polar billing is scaffolded; pricing wiring awaits validation. Datasets + Evals dashboard pillars are scaffolded as placeholder routes only; backend wiring is the next design pass. See [`STATUS.md`](STATUS.md).

```bash
# TypeScript:
npx @artanis-ai/gravel init

# Python:
uvx artanis-gravel init

# Direct binary (Docker, CI, polyglot repos):
curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh && gravel init
```

The wizard logic lives in a single Go binary cross-compiled per platform. The npm and PyPI SDK packages each ship a thin (~100-line) wrapper that lazy-downloads the matching binary from signed GitHub Release assets on first invocation, so installing the SDK gives you a working `gravel` command in one step. No bundled binary in the SDK tarballs. See [`cli/DESIGN.md`](cli/DESIGN.md).

## What it is

Gravel is a library you install into your existing AI engineering codebase (TypeScript or Python). Once installed, an admin dashboard mounts inside your app at `/admin/ai`. From there, your **domain experts** (clinicians, lawyers, teachers, recruiters, accountants, whoever) can:

- See every prompt in the codebase, edit it, and submit a GitHub PR for the change.
- Review LLM traces flowing through your pipeline, leave feedback and corrections.
- Build datasets from labelled traces and run evals against them.

Where Langfuse / LangSmith pitch dashboards to engineers, **Gravel ships a dashboard for the people whose job *isn't* engineering**: the ones who actually know what good looks like in your domain.

## What's open-source

This repo is the embedded library. It's Apache 2.0. You can audit every line, fork it, run it.

The judge service it talks to for paid evals is closed-source and lives elsewhere. That's the only thing not in this repo. Tracing data and prompts always stay in your own database; only rows being judged ever leave your infrastructure.

## Repo layout

```
gravel/
├── install.sh              # `curl | sh` install for the CLI binary (POSIX)
├── install.ps1             # PowerShell equivalent for native Windows
├── cli/                    # Go module: single source of truth for the `gravel` wizard
├── packages/sdk-ts/        # @artanis-ai/gravel: SDK library + bin/gravel.js wrapper
├── packages/dashboard/     # React app shipped inside the SDKs
├── python/gravel/          # artanis-gravel: SDK library + artanis_gravel._cli wrapper
├── examples/               # Next.js, FastAPI, Django integration examples (Express / Hono / Fastify / Flask exercised via gravel-test-fixtures)
└── .github/workflows/      # CI: lint, test, schema-drift, cross-compile + release
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The architecture overview is in [`ARCHITECTURE.md`](ARCHITECTURE.md); rolling progress notes are in [`STATUS.md`](STATUS.md). The wizard is self-explanatory: run `gravel init` and it tells you what it's doing. The dashboard documents itself in its empty states and banners.

## License

Apache 2.0. See [`LICENSE`](LICENSE).
