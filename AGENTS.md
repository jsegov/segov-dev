# AGENTS.md

Instructions in this file apply to the entire repository unless a closer nested `AGENTS.md` overrides them.

## Project Overview

- This repo is a frontend-only Next.js portfolio.
- `about`, `career`, and `projects` content is loaded from Vercel Edge Config key `siteContent`.
- Blog content is loaded from private Vercel Blob storage using `BLOB_BLOG_PREFIX`.
- AMA chat is implemented in Next.js API routes using AI SDK Agents.
- Resume context for chat is loaded from private Vercel Blob storage.
- Additional AMA context is loaded from private Vercel Blob storage under two hard-coded prefixes: `work/` (work-related docs) and `personal/` (side-project docs).

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
- `AMA_INFERENCE_BASE_URL` (optional: OpenAI-compatible endpoint for a fine-tuned deployment, e.g. Tinker's `.../oai/api/v1`; when set, it replaces AI Gateway routing)
- `AMA_INFERENCE_API_KEY` (optional: bearer token for the inference endpoint)
- `AMA_INFERENCE_HEADERS` (optional: JSON object of extra request headers, for endpoints whose auth is not Bearer-shaped — e.g. Modal proxy auth `{"Modal-Key":"wk-...","Modal-Secret":"ws-..."}`)
- `AMA_DEPLOYMENT_MODEL` (required with `AMA_INFERENCE_BASE_URL`: the served model id, e.g. a `tinker://.../sampler_weights/final` checkpoint path)
- `AMA_INFERENCE_REASONING_EFFORT` (optional: `none`..`xhigh` or a float in `[0, 0.99]`; must match the effort the checkpoint was trained with)
- `DATABASE_URL` (Vercel-injected Neon connection string used for AMA trace persistence)
- `AMA_TRACE_LOGGING_ENABLED` (optional; set to `0` to disable trace writes)
- `EDGE_CONFIG`
- `BLOB_READ_WRITE_TOKEN`
- `BLOB_BLOG_PREFIX`
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
