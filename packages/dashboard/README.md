# @artanis-ai/gravel-dashboard

The React app shipped inside both the TypeScript and Python SDKs.

**Status:** active. Login, samples list + detail, prompt editor with embedded-slice editing, prompt PR submission, GitHub App install, pending-migrations banner, and update banner all ship today. The Datasets and Evals tabs are the next pillars in flight.

## Layout

```
src/
├── main.tsx                  # bootstraps React + TanStack Query
├── App.tsx                   # routes
├── styles.css                # tailwind + warm scrollbar
├── components/
│   ├── Layout.tsx
│   ├── EmptyState.tsx
│   ├── LoadingPage.tsx
│   ├── PendingMigrationsBanner.tsx
│   ├── UpdateBanner.tsx
│   ├── CopyableCode.tsx
│   └── prompts/
│       ├── PromptBadge.tsx
│       ├── SubmitModal.tsx
│       └── SuggestionEditor.tsx
├── lib/
│   ├── api.ts                # same-origin fetch wrapper
│   ├── drafts.ts             # localStorage draft management
│   ├── format.ts
│   ├── types.ts
│   └── useCurrentUser.ts
└── routes/
    ├── Prompts.tsx
    ├── PromptDetail.tsx
    ├── Samples.tsx
    ├── Datasets.tsx
    ├── Evals.tsx
    ├── Analysis.tsx
    └── Login.tsx
```

## Build pipeline

`pnpm build` produces `dist/`. The release workflows copy this directory into both SDKs:

- TypeScript: `packages/sdk-ts/src/_dashboard/` (read by the handler at runtime via `handler/dashboard-bundle.ts`).
- Python: `python/gravel/src/artanis_gravel/_dashboard_dist/` (pre-staged before `python -m build --wheel` by `tools/sync-dashboard-dist.sh`; included via the `[tool.hatch.build.targets.wheel.artifacts]` glob in `pyproject.toml`).

Editable installs leave the dir absent and the SDK's `find_dashboard_dist()` walks up the source tree to locate the live dev build.
