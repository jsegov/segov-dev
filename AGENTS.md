# AGENTS.md

Instructions in this file apply to the entire repository unless a closer nested `AGENTS.md` overrides them.

## Project Overview

- This repo is a frontend-only Next.js portfolio.
- AMA chat is implemented in Next.js API routes using AI SDK Agents.
- Resume context for chat is loaded from private Vercel Blob storage.

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
- `AMA_CHAT_MODEL` (default: `openai/gpt-5-mini`)
- `AMA_CHAT_PROVIDERS` (optional: `openai` or `vertex,anthropic`; leave unset for AI Gateway auto-routing)
- `BLOB_READ_WRITE_TOKEN`
- `BLOB_RESUME_PATH`

Do not commit any `.env*` files.

## Code Style

- TypeScript strict mode
- Single quotes
- No semicolons
- Prettier + ESLint

Run `pnpm lint` before committing.

## Testing

- Unit tests use Vitest + React Testing Library.
- Keep tests in `frontend/tests`.
- Add tests for chat route behavior, blob resume retrieval behavior, and AMA UI behavior when changing chat flow.

## Development Workflow

1. `pnpm install`
2. `pnpm dev`
3. Make changes in `frontend/`
4. `pnpm lint && pnpm test && pnpm build`

## Agent Notes

- Root instructions apply by default.
- Nested `AGENTS.md` files take precedence for files under their directories.
- Keep chat runtime frontend-only; do not add backend/infra service dependencies without explicit user request.
