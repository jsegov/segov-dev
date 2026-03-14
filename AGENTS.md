# AGENTS.md

Instructions in this file apply to the entire repository.

## Project Overview

- This repo is a single-package Next.js portfolio app.
- AMA chat is implemented in Next.js API routes using AI SDK Agents.
- Resume context for chat is loaded from private Vercel Blob storage.
- AMA provider routing is read from Vercel Edge Config and refreshed by Vercel Cron.

## Setup Commands

Install dependencies:

```bash
pnpm install
```

Start development server:

```bash
pnpm dev
```

Build:

```bash
pnpm build
```

Lint:

```bash
pnpm lint
```

Test:

```bash
pnpm test
```

## Environment Variables

Configure these for local and production:

- `AI_GATEWAY_API_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `BLOB_RESUME_PATH`
- `AMA_DEFAULT_MODEL`
- `AMA_FALLBACK_MODEL`
- `AMA_SESSION_SECRET`
- `CRON_SECRET`
- `AMA_EDGE_CONFIG_ID`
- `VERCEL_API_TOKEN`
- `VERCEL_TEAM_ID` (optional)

Do not commit any `.env*` files.

## Code Style

- TypeScript strict mode
- Single quotes
- No semicolons
- Prettier + ESLint

Run `pnpm lint` before committing.

## Testing

- Unit tests use Vitest + React Testing Library.
- Keep tests in `tests/`.
- Add tests for chat route behavior, AMA session bootstrap, Edge Config routing behavior, and cron/manual routing updates when changing AMA flow.

## Development Workflow

1. `pnpm install`
2. `pnpm dev`
3. Make changes in the root app directories (`app/`, `components/`, `lib/`, `tests/`, etc.)
4. `pnpm lint && pnpm test && pnpm build`

## Agent Notes

- Keep chat runtime frontend-only; do not add backend/infra service dependencies without explicit user request.
