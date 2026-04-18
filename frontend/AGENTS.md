# AGENTS.md

Instructions in this file apply to everything under `frontend/`.

## Frontend Overview

- Next.js 15 App Router app with TypeScript and Tailwind CSS.
- `about`, `career`, and `projects` content comes from Vercel Edge Config key `siteContent`.
- Blog content comes from private Vercel Blob storage using `BLOB_BLOG_PREFIX`.
- Additional AMA context comes from private Vercel Blob storage under two hard-coded prefixes: `work/` (work docs) and `personal/` (side-project docs).
- AMA chat is frontend-only:
  - API route: `frontend/app/api/chat/route.ts`
  - Agent setup: `frontend/lib/ama-agent.ts`
  - Resume loader: `frontend/lib/resume-context.ts`
  - Work and personal context loaders: `frontend/lib/ama-context.ts` (`searchWorkContextFromBlob`, `searchPersonalContextFromBlob`)

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

## Testing

- Run:
  - `pnpm test`
  - `pnpm lint`
  - `pnpm build`
- Add/update tests when changing:
  - `/api/chat` route behavior
  - blob resume retrieval logic
  - AMA chat UI interaction behavior

## Environment Variables

- `AI_GATEWAY_API_KEY`
- `AMA_CHAT_MODEL` (default: `openai/gpt-5-mini`)
- `AMA_CHAT_PROVIDERS` (optional: `openai` or `vertex,anthropic`; provider slugs must match the selected model, leave unset for AI Gateway auto-routing)
- `EDGE_CONFIG`
- `BLOB_READ_WRITE_TOKEN`
- `BLOB_BLOG_PREFIX`
- `BLOB_RESUME_PATH`
