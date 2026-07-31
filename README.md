# Jonathan Segovia Portfolio

A frontend-only Next.js portfolio with an AMA chat page powered by Vercel AI SDK Agents and Vercel Blob.

## Stack

- Next.js 15 + React 19 + TypeScript
- Tailwind CSS
- AI SDK v6 (`ToolLoopAgent` + `createAgentUIStreamResponse`)
- Vercel AI Gateway model/provider routing is configurable for AMA via env vars
- Vercel Blob (private store) for resume retrieval and additional AMA context
- Neon Postgres for best-effort, server-side AMA trace persistence

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
- `AMA_INFERENCE_BASE_URL` (optional: OpenAI-compatible endpoint for a fine-tuned deployment, e.g. Tinker's `.../oai/api/v1`; when set, it replaces AI Gateway routing)
- `AMA_INFERENCE_API_KEY` (optional: bearer token for the inference endpoint)
- `AMA_DEPLOYMENT_MODEL` (required with `AMA_INFERENCE_BASE_URL`: the served model id, e.g. a `tinker://.../sampler_weights/final` checkpoint path)
- `AMA_INFERENCE_REASONING_EFFORT` (optional: `none`..`xhigh` or a float in `[0, 0.99]`; must match the effort the checkpoint was trained with)
- `DATABASE_URL` (injected by the connected Neon integration)
- `AMA_TRACE_LOGGING_ENABLED` (optional; set to `0` to disable trace writes)
- `EDGE_CONFIG`
- `BLOB_READ_WRITE_TOKEN`
- `BLOB_BLOG_PREFIX`
- `BLOB_RESUME_PATH`

Leave `AMA_CHAT_PROVIDERS` unset to let AI Gateway auto-route across supported providers. If you set it, use provider slugs that are valid for the selected `AMA_CHAT_MODEL`.

Use Node.js 20 or newer. AMA trace writes run after the streamed response closes and are
best-effort; they do not expose a trace-reading API.

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

## AMA Evals

The AMA chatbot has a live-model eval suite that uses sanitized fixtures instead of real Edge Config
or Blob content:

```bash
pnpm --filter frontend eval:ama
pnpm --filter frontend eval:ama:ci
```

Set `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` before running live evals. Optional eval
overrides are `AMA_EVAL_MODEL`, `AMA_EVAL_PROVIDERS`, `AMA_EVAL_MAX_OUTPUT_TOKENS`,
`AMA_EVAL_CONCURRENCY`, `AMA_EVAL_USE_JUDGE`, and `AMA_EVAL_JUDGE_MODEL`.

To eval a fine-tuned deployment instead of a gateway model, set `AMA_INFERENCE_BASE_URL`,
`AMA_INFERENCE_API_KEY`, and `AMA_DEPLOYMENT_MODEL` (the same variables the app uses).
The LLM judge still requires `AI_GATEWAY_API_KEY` and defaults to `openai/gpt-5-mini`
when the subject model is served from an inference endpoint.

## Repo Layout

```text
segov-dev/
├── frontend/   # Next.js application
└── .github/    # frontend workflows
```
