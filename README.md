# Jonathan Segovia Portfolio

A frontend-only Next.js portfolio with an AMA chat page powered by Vercel AI SDK Agents and Vercel Blob.

## Stack

- Next.js 15.5.25 + React 19.1.9 + TypeScript (the [patched 15.5 release line](https://nextjs.org/blog/august-2026-security-release))
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
- The route accepts user/assistant text only. Its public SSE projection removes tool payloads,
  reasoning, sources, and metadata after agent execution; complete tool results stay in server
  model context and traces. Client-supplied system messages and file/tool parts are rejected.
- Agent tool `get_resume` reads resume context from private Blob using `BLOB_RESUME_PATH`
- Agent tools `search_work_context` and `search_personal_context` search `.md`, `.mdx`, and `.txt` files from private Blob under the hard-coded `work/` and `personal/` prefixes respectively

## Environment Variables

Set these in `frontend/.env.local` for local development and in Vercel project settings for production:

- `AI_GATEWAY_API_KEY`
- `AMA_CHAT_MODEL` (default: `openai/gpt-5-mini`)
- `AMA_MAX_OUTPUT_TOKENS` (positive integer; defaults to the committed value in `frontend/lib/ama-defaults.json`, initially 512)
- `AMA_CHAT_PROVIDERS` (optional: `openai` or `vertex,anthropic`)
- `AMA_INFERENCE_BASE_URL` (optional: OpenAI-compatible endpoint for a fine-tuned deployment, e.g. Tinker's `.../oai/api/v1`; when set, it replaces AI Gateway routing)
- `AMA_INFERENCE_API_KEY` (optional: bearer token for the inference endpoint)
- `AMA_INFERENCE_HEADERS` (optional: JSON object of extra request headers, for endpoints whose auth is not Bearer-shaped — e.g. Modal proxy auth `{"Modal-Key":"wk-...","Modal-Secret":"ws-..."}`)
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
pnpm --filter frontend format:check
pnpm --filter frontend typecheck
pnpm test
pnpm build
pnpm --filter frontend test:browser:install
pnpm --filter frontend test:browser
pnpm --filter ama-training test
uv run --project training --group dev python -m pytest training/tests
```

## AMA Evals

The AMA chatbot has a live-model eval suite that uses sanitized fixtures instead of real Edge Config
or Blob content:

```bash
pnpm --filter frontend eval:ama
pnpm --filter frontend eval:ama:ci
```

Production is the default profile and uses the runtime model, call settings, streaming protocol,
and browser transport with synthetic context. Production and tuning require an independent
gateway judge for cases with judge rubrics. Missing judge evidence cannot pass a release gate.
Use `eval:ama:benchmark` for the historical 2,400-token deterministic profile; `AMA_EVAL_MODEL`,
`AMA_EVAL_PROVIDERS`, and `AMA_EVAL_MAX_OUTPUT_TOKENS` are benchmark-only overrides.

`pnpm --filter frontend eval:ama:matrix` explicitly makes live model calls for four budgets and
three repetitions each. It chooses the smallest budget within one percentage point of the best
passing aggregate quality, only when every repetition passes. If no budget qualifies, retain the
committed default. Reports record settings, provenance hashes, usage, latency, judge coverage,
and per-case outcomes. See [evaluation operations](frontend/evals/ama/README.md) for final-suite
locks, evidence bindings, offline selection, and exporting training exclusion fingerprints.

Configure the frontend CI `AMA_CHAT_*`, `AMA_MAX_OUTPUT_TOKENS`, and optional inference settings
to match Vercel production. Live evaluations skipped for unavailable credentials are unevaluated;
they are never evidence for checkpoint promotion. Browser tests use synthetic network fixtures.

To eval a fine-tuned deployment instead of a gateway model, set `AMA_INFERENCE_BASE_URL`,
`AMA_DEPLOYMENT_MODEL`, and the endpoint's auth — `AMA_INFERENCE_API_KEY` (Bearer) and/or
`AMA_INFERENCE_HEADERS` (custom headers, e.g. Modal proxy auth) — the same variables the app uses.
The LLM judge still requires `AI_GATEWAY_API_KEY` and defaults to `openai/gpt-5-mini`
when the subject model is served from an inference endpoint.

## Training and releases

Training consumes explicitly reviewed synthetic snapshots. Visitor conversations are excluded.
Content hashes bind approvals to the complete trace, and persisted conversation/family splits
keep training, selection, and final examples separate. Every training run performs a full
train/selection preflight before contacting Tinker.

The checkpoint registry separates latest training state, candidates, and the deployable pointer.
The final-evaluation command claims a single attempt for the locked winner and automatically
promotes only when all bound checks pass; failure preserves the previous deployable checkpoint.
Deployment is a separate command. Legacy checkpoints require verifiable training provenance to
be eligible. See [training operations](training/README.md) and [serving verification](training/deploy/README.md).

## Repo Layout

```text
segov-dev/
├── frontend/   # Next.js application
├── training/   # reviewed datasets, training, serving and release verification
└── .github/    # frontend and training workflows
```
