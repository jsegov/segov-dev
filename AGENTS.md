# AGENTS.md

Instructions in this file apply to the entire repository unless a closer nested `AGENTS.md` overrides them.

## Project Overview

- This repo is a frontend-only Next.js 15 App Router portfolio.
- `about`, `career`, and `projects` content is loaded from Vercel Edge Config key `siteContent`.
- Blog content is loaded from private Vercel Blob storage using `BLOB_BLOG_PREFIX`.
- AMA chat is implemented in Next.js API routes using AI SDK Agents.
- Resume context for chat is loaded from private Vercel Blob storage.
- Additional AMA context is loaded from private Vercel Blob storage under two hard-coded prefixes: `work/` (work-related docs) and `personal/` (side-project docs).

## Chat Architecture Rules

- Use AI SDK Agents (`ToolLoopAgent`) for chat orchestration.
- Use `createAgentUIStreamResponse` for `/api/chat` streaming responses.
- Keep the AMA page on `useChat` with `DefaultChatTransport`.
- Resume context must come from private Blob via `BLOB_RESUME_PATH`.
- Work context must come from private Blob under the hard-coded `work/` prefix; personal/side-project context from the hard-coded `personal/` prefix. Do not reintroduce an env var for these.
- Do not reintroduce backend proxy, Cloud Run, WIF, MCP, or vLLM coupling.

## UX Rules

- Preserve existing terminal-inspired AMA and site visual style unless requested otherwise.
- Keep assistant responses plain text and concise.

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
- Keep tests in `tests`.
- Add tests for chat route behavior, blob resume retrieval behavior, and AMA UI behavior when changing chat flow.

## Development Workflow

1. `pnpm install`
2. `pnpm dev`
3. Make changes in the root Next.js app
4. `pnpm lint && pnpm test && pnpm build`

## Agent Notes

- Root instructions apply by default.
- Nested `AGENTS.md` files take precedence for files under their directories.
- Keep chat runtime frontend-only; do not add backend/infra service dependencies without explicit user request.
