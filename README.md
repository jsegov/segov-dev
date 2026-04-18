# Jonathan Segovia Portfolio

A frontend-only Next.js portfolio with an AMA chat page powered by Vercel AI SDK Agents and Vercel Blob.

## Stack

- Next.js 15 + React 19 + TypeScript
- Tailwind CSS
- AI SDK v6 (`ToolLoopAgent` + `createAgentUIStreamResponse`)
- Vercel AI Gateway model/provider routing is configurable for AMA via env vars
- Vercel Blob (private store) for resume retrieval and additional AMA context

## Architecture

- UI pages are in `frontend/app/*`
- Portfolio content for `about`, `career`, and `projects` is loaded from Vercel Edge Config key `siteContent`
- Blog content is loaded from private Vercel Blob storage under the `BLOB_BLOG_PREFIX` prefix
- AMA chat UI uses `useChat` and streams from `POST /api/chat`
- Server route `frontend/app/api/chat/route.ts` runs the agent
- Agent tool `get_resume` reads resume context from private Blob using `BLOB_RESUME_PATH`
- Agent tools `search_work_context` and `search_personal_context` search `.md`, `.mdx`, and `.txt` files from private Blob under the hard-coded `work/` and `personal/` prefixes respectively

## Environment Variables

Set these in `frontend/.env.local` for local development and in Vercel project settings for production:

- `AI_GATEWAY_API_KEY`
- `AMA_CHAT_MODEL` (default: `openai/gpt-5-mini`)
- `AMA_CHAT_PROVIDERS` (optional: `openai` or `vertex,anthropic`)
- `EDGE_CONFIG`
- `BLOB_READ_WRITE_TOKEN`
- `BLOB_BLOG_PREFIX`
- `BLOB_RESUME_PATH`

Leave `AMA_CHAT_PROVIDERS` unset to let AI Gateway auto-route across supported providers. If you set it, use provider slugs that are valid for the selected `AMA_CHAT_MODEL`.

## Development

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Quality Checks

```bash
pnpm lint
pnpm test
pnpm build
```

## Repo Layout

```text
segov-dev/
├── frontend/   # Next.js application
└── .github/    # frontend workflows
```
