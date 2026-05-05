# @artanis/gravel-dashboard

The React app shipped inside both the TypeScript and Python SDKs.

**Status:** scaffold. Routes are stubbed; full prompt editor + trace inbox land alongside the SDK route handlers in the next session.

## Layout

```
src/
├── main.tsx              # bootstraps React + TanStack Query
├── App.tsx               # routes
├── styles.css            # tailwind + warm scrollbar
├── components/
│   ├── Layout.tsx
│   ├── EmptyState.tsx
│   └── LoadingPage.tsx
├── lib/api.ts            # same-origin fetch wrapper
└── routes/
    ├── Prompts.tsx
    ├── Traces.tsx
    ├── Datasets.tsx
    ├── Evals.tsx
    ├── Analysis.tsx
    ├── Settings.tsx
    └── Login.tsx
```

## Build pipeline

`pnpm build` produces `dist/`. Both SDKs copy this directory at release time:

- `packages/sdk-ts/src/_dashboard/` (used by the TS handler at runtime)
- `python/gravel/src/artanis_gravel/_dashboard/` (copied into the Python wheel)

The copy step is part of the release workflow (BLOCKER: not yet wired up — see `gravel-cloud/docs/blockers.md` §release).
