# Jonathan Segovia Portfolio

A frontend-only Next.js portfolio with an AMA chat page powered by Vercel AI SDK Agents and Vercel Blob.

## Stack

- Next.js 15 + React 19 + TypeScript
- Tailwind CSS
- AI SDK v6 (`ToolLoopAgent` + `createAgentUIStreamResponse`)
- Vercel AI Gateway model: `openai/gpt-5-mini`
- Vercel Blob (private store) for resume retrieval

## Architecture

- UI pages are in `frontend/app/*`
- File-based portfolio content is in `frontend/data/*`
- AMA chat UI uses `useChat` and streams from `POST /api/chat`
- Server route `frontend/app/api/chat/route.ts` runs the agent
- Agent tool `get_resume` reads resume context from private Blob using `BLOB_RESUME_PATH`

## Environment Variables

Set these in `frontend/.env.local` for local development and in Vercel project settings for production:

- `AI_GATEWAY_API_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `BLOB_RESUME_PATH`

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
