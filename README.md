# Jonathan Segovia Portfolio

A frontend-only Next.js portfolio with an AMA chat page powered by Vercel AI SDK Agents, Vercel AI Gateway, Vercel Blob, and Vercel Edge Config.

## Stack

- Next.js 15 + React 19 + TypeScript
- Tailwind CSS
- AI SDK v6 (`ToolLoopAgent` + `createAgentUIStreamResponse`)
- Vercel AI Gateway for AMA model/provider routing
- Vercel Edge Config for AMA routing snapshots
- Vercel Blob for resume retrieval
- Vercel Cron for daily provider refresh

## Architecture

- UI pages live in `app/*`
- File-based portfolio content lives in `data/*`
- AMA chat UI uses `useChat` and streams from `POST /api/chat`
- `GET /api/ama/session` bootstraps a sticky AMA routing session cookie per browser session
- `POST /api/chat` reads the signed AMA routing session and performs app-level model fallback
- `GET /api/ama/routing/refresh` refreshes provider routing from AI Gateway endpoint pricing and writes it to Edge Config
- Agent tool `get_resume` reads resume context from private Blob using `BLOB_RESUME_PATH`

## Environment Variables

Set these in `.env.local` for local development and in Vercel project settings for production:

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

## Operations

- Manual AMA provider updates:
  `pnpm ama:routing:set --model <creator/model> --default-provider <provider> --fallback-provider <provider>`
- Daily cron schedule:
  [vercel.json](/Users/segov/personal_projects/segov-dev/vercel.json)

## Repo Layout

```text
segov-dev/
├── app/         # Next.js routes and API handlers
├── components/  # UI components
├── data/        # File-based portfolio content
├── lib/         # AMA agent, routing, and content helpers
└── tests/       # Vitest coverage
```
