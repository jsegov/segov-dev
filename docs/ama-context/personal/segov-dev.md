# segov-dev — Jonathan Segovia's personal portfolio site

Source: https://github.com/jsegov/segov-dev — deployed at segov.dev.

## What it is

A personal, frontend-only Next.js portfolio site with a terminal-inspired visual style and an "Ask Me Anything" (AMA) chat page. The chat page is the centerpiece: visitors can ask questions about Jonathan's background, career, and side projects, and a Claude/GPT-backed agent answers using private context Jonathan has uploaded (resume, work design docs, side-project notes).

## Why it exists

Two goals:

1. Replace a static "about me / resume" portfolio with something interactive. Recruiters, peers, and collaborators can ask questions in natural language instead of skimming bullet points.
2. Serve as Jonathan's personal sandbox for building with modern LLM tooling end-to-end — agent loops, tool use, retrieval from private storage, streaming UIs — on real content, not a toy demo.

Everything on the site is built around supporting the AMA experience. Other pages (career, projects, blog) provide authoritative fallback content when the agent can't answer.

## Tech stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript** (strict mode)
- **Tailwind CSS** with a custom terminal-themed palette; Radix UI primitives for accessible components
- **AI SDK v6** (`ai` package, `ToolLoopAgent`, `createAgentUIStreamResponse`) for the agent loop and streaming
- **@ai-sdk/react** (`useChat` + `DefaultChatTransport`) for the client-side chat UI
- **Vercel AI Gateway** for model/provider routing, configured via `AMA_CHAT_MODEL` + `AMA_CHAT_PROVIDERS` env vars
- **Vercel Blob** (private store) for resume, blog posts, and AMA context documents
- **Vercel Edge Config** for structured, fast-reading site content (about/career/projects)
- **Vitest** + React Testing Library + happy-dom for unit tests
- **Prettier + ESLint** with single quotes, no semicolons, TypeScript strict
- **pnpm** workspace, deployed on **Vercel**

Code style notes: formatting is strictly enforced via `pnpm format:check` in CI. Tests use Vitest's mocking system (e.g. `vi.mock('@vercel/blob')`). There is no backend service — everything runs inside the Next.js app on Vercel.

## Architecture at a glance

```
Browser (React) ──useChat──▶ /api/chat  ──▶  ToolLoopAgent ──▶  AI Gateway ──▶  LLM
                                 │                  │
                                 │                  ├─ get_resume                 ┐
                                 │                  ├─ search_work_context        │
                                 │                  └─ search_personal_context    │ private
                                 │                                                │ Vercel
                                 └─ Edge Config (siteContent: about/career/projects)
                                                                                  │ Blob
                                 Static pages (/, /career, /projects, /blog) ─────┘
                                          └─ read from Edge Config + Blob at request time
```

Request flow for a chat message:

1. Client calls `POST /api/chat` with a messages array.
2. `frontend/app/api/chat/route.ts` validates the body and delegates to `createAgentUIStreamResponse({ agent, messages })`.
3. The `ToolLoopAgent` (defined in `frontend/lib/ama-agent.ts`) runs with a system prompt that enforces scope ("only Jonathan") and a work-context disclosure policy, and with three tools available.
4. Depending on the question, the agent calls `get_resume`, `search_work_context`, or `search_personal_context`. Each tool reads from private Vercel Blob — the resume is a single blob at `BLOB_RESUME_PATH`; work docs live under the hard-coded `work/` prefix; personal/side-project docs under `personal/`.
5. The response streams back token-by-token to the terminal-styled chat UI at `/ama`.

## Key pages and features

- **`/` (home)** — terminal prompt UI: `$ whoami`, `$ cat about.txt`, `$ ls` listing the other sections. The "about" text comes from Edge Config.
- **`/career`** — career entries (title, company, dates, description, skills) from Edge Config.
- **`/projects`** — side-project entries (name, description, skills, GitHub link, optional website) from Edge Config.
- **`/blog`** and **`/blog/[slug]`** — markdown blog posts with frontmatter (`title`, `publishedDate`, `excerpt`, `coverImage`), served from private Vercel Blob under `BLOB_BLOG_PREFIX`. Uses `gray-matter` for frontmatter parsing and `react-markdown` + `remark-gfm` for rendering.
- **`/ama`** — the AMA chat page. Styled as a terminal (`segov@terminal:~$` prompt, monospace font). Uses `useChat` to stream replies from `/api/chat`. Starts with a welcome line; users type questions, responses stream in as plain text.
- **Top nav** (`components/navbar.tsx`) — links between pages. Theme toggle (light/dark) via `next-themes`.

## AMA chat — the interesting part

### Agent setup (`frontend/lib/ama-agent.ts`)

The agent is a `ToolLoopAgent` constructed per-process (module-scoped in the route). It has:

- A detailed system prompt pinning scope ("only answer questions about Jonathan Segovia"), specifying tool routing, and including a **work-context disclosure policy** (more on that below).
- Three tools registered with Zod schemas:
  - `get_resume` — called first for general career/background questions. Pulls the single resume blob.
  - `search_work_context` — called for questions about past employers, work architecture, or design docs from work. Searches the `work/` prefix.
  - `search_personal_context` — called for questions about side projects. Searches the `personal/` prefix.
- An out-of-scope refusal string (`Error: Query outside permitted scope. ...`) for non-Jonathan questions.

Tool-routing rule in the prompt: call the one tool that matches the question's domain. Both work and personal tools should only be called when a question truly spans both.

### Context retrieval (`frontend/lib/ama-context.ts`)

`searchWorkContextFromBlob(query)` and `searchPersonalContextFromBlob(query)` are thin wrappers around a shared `searchContextFromBlob(prefix, query)` that does the real work:

1. **List** supported blobs under the prefix (`.md`, `.mdx`, `.txt`), paginating through Vercel Blob's cursor API, early-breaking at `MAX_FILES_TO_READ` (25).
2. **Fetch** every listed blob in parallel via `Promise.all` + per-blob try/catch, tracking fetch failures separately from empty blobs so the error taxonomy is honest.
3. **Tokenize** the query via regex (`/[a-z0-9+#]+/g`), lowercasing, dropping stop words, and filtering out terms shorter than 3 characters unless they appear in a `SHORT_TECHNICAL_TERMS` allowlist (`ai`, `ci`, `cd`, `c#`, `db`, `f#`, `go`, `js`, `ml`, `os`, `qa`, `ts`, `ui`, `ux`). This is so queries like "Go, C#, or AI?" surface real matches without `to`/`of`/`in`/`is`/... poisoning the results.
4. **Chunk** each document by paragraphs into ≤1600-char chunks.
5. **Score** each chunk by term occurrence count. Occurrences use word-bounded matching via lookaround (`(?<![a-z0-9])term(?![a-z0-9])`), not substring — this avoids `go` matching "going" or `ai` matching "maintain". Path matches weight 2×.
6. **Rank + slice** the top 5 chunks across all docs, build a single content string with `Source N: <path>` + uploaded date + size + excerpt headers, capped at 6000 chars total.
7. **Return** a typed result with `available`, `source` (one of `blob | list_failed | no_supported_files | blob_fetch_failed | empty_files | no_matches`), `query`, `matches`, and `content`. The agent uses these source codes to distinguish infra failures from "no relevant content" cases.

Why in-memory keyword scoring instead of a vector DB: the corpus is small (dozens of docs), the questions are mostly lexical, and skipping a vector store keeps the deployment Vercel-only with no extra infra. If relevance ever becomes a real problem, embeddings + pgvector or Turbopuffer would be the natural next step — but the current setup is intentionally boring.

### Work-context disclosure policy

Because the `work/` corpus can contain material Jonathan is contractually or ethically obligated not to share (customer names, business metrics, unreleased roadmap, service internals, verbatim passages), the system prompt includes a scoped disclosure policy that applies **only** to `search_work_context` results — personal docs and resume content are unrestricted. The policy:

- Tells the agent what it *should* discuss for work topics: the technical problem, high-level approach, user/business purpose at a conceptual level.
- Enumerates hard prohibitions: no customer/partner/account names, no specific numbers (revenue, SLOs, counts), no unreleased roadmap, no implementation details (schemas, APIs, architecture diagrams), no direct quotes or close paraphrases, no personnel names beyond Jonathan.
- Provides a prefer/avoid example pair.
- Instructs the agent to refuse opaquely — do not describe *what* was omitted, since the shape of the refusal can itself leak.

Prompt-based confidentiality is a soft guarantee. Source-layer redaction before uploading work documents is the intended first line of defense; the prompt is belt-and-suspenders.

### UI (`frontend/app/ama/page.tsx`)

Client component. `useChat` from `@ai-sdk/react` with an initial assistant message styled as a shell prompt. User messages render as `segov@terminal:~$ <text>`; assistant messages render as plain text with `whitespace-pre-line` to preserve newlines. On error, a toast pops up. Uses `requestIdleCallback`-free smooth scroll to keep the latest reply visible.

## Content pipeline

Content is split by cadence-of-change and sensitivity:

- **About / Career / Projects** → **Edge Config** (`siteContent` key). Zod-validated on read. Edits go through the Vercel dashboard and deploy instantly (no rebuild). Good for structured, frequently-referenced content that needs to be fast.
- **Blog posts** → **Vercel Blob**, markdown with frontmatter, one file per post, direct children of `BLOB_BLOG_PREFIX`. Rendered server-side per request. Good for long-form content where markdown is the natural authoring format.
- **Resume** → **Vercel Blob**, single file at `BLOB_RESUME_PATH`. Private; only reachable through the AMA tool.
- **AMA context docs** → **Vercel Blob** under hard-coded `work/` and `personal/` prefixes. Private. Retrieved on-demand by the agent tools.

Hard-coding the `work/` and `personal/` prefixes (rather than making them env vars) is deliberate — it keeps the agent's domain routing honest and prevents accidental reconfiguration that would cross-contaminate the disclosure policy.

## Notable design decisions

- **Frontend-only.** Earlier iterations proxied chat through a Cloud Run backend with Workload Identity Federation, MCP, and vLLM. All of that was removed in favor of a Next.js-only architecture running entirely on Vercel. The `frontend/AGENTS.md` explicitly forbids reintroducing any of those couplings without explicit user request. Reason: operational simplicity; a personal site shouldn't require managing a separate service.
- **AI Gateway for model flexibility.** `AMA_CHAT_MODEL` defaults to `openai/gpt-5-mini` but can be swapped to any `creator/model-name` slug the gateway supports. `AMA_CHAT_PROVIDERS` optionally pins a provider order (e.g. `vertex,anthropic` for Claude via Vertex). Model id and provider slugs are validated by regex with explicit error messages; providers left unset means gateway auto-routes.
- **Zod schemas at trust boundaries.** Both `siteContent` reads (from Edge Config) and the agent's tool inputs validate with Zod. Any schema mismatch throws with the Zod error as `cause` so the actual shape problem is surfaced, not a generic failure.
- **Error taxonomy, not just booleans.** Context retrieval returns a typed `source` discriminator (`list_failed` vs. `no_supported_files` vs. `blob_fetch_failed` vs. `empty_files` vs. `no_matches`) so the agent can distinguish "the infra broke" from "you asked something the corpus doesn't cover." This lets the model give the user an honest response.
- **No client-side secrets.** `AI_GATEWAY_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `EDGE_CONFIG` connection string, and `BLOB_RESUME_PATH` are all server-side only.
- **Tests are the safety net for agent-adjacent changes.** `frontend/tests/` covers the chat route, agent construction, context retrieval (pagination, fallback sources, word-boundary matching, short-term acronyms), and blog loader behavior. A specific test asserts the work-context disclosure policy text is present in `AMA_INSTRUCTIONS` so accidental deletions get caught. The user has a standing rule: never skip or trivially bypass a failing test — fix the test or the implementation.

## Environment variables

Server-side only. Configured in `frontend/.env.local` for dev and in Vercel project settings for production.

- `AI_GATEWAY_API_KEY` — auth for Vercel AI Gateway
- `AMA_CHAT_MODEL` — default `openai/gpt-5-mini`, format `creator/model-name`
- `AMA_CHAT_PROVIDERS` — optional comma list like `vertex,anthropic`; unset for gateway auto-routing
- `EDGE_CONFIG` — Edge Config connection string for `siteContent`
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob auth
- `BLOB_BLOG_PREFIX` — prefix under which blog `.md` files live
- `BLOB_RESUME_PATH` — full blob pathname for the resume file

## Repo layout

```text
segov-dev/
├── AGENTS.md              # root AGENTS instructions
├── README.md
├── frontend/              # Next.js application (the whole app lives here)
│   ├── AGENTS.md          # frontend-specific rules
│   ├── app/               # App Router pages + API routes
│   │   ├── ama/page.tsx
│   │   ├── api/chat/route.ts
│   │   ├── blog/
│   │   ├── career/
│   │   ├── projects/
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/        # React components (navbar, markdown renderer, UI primitives)
│   ├── lib/
│   │   ├── ama-agent.ts          # ToolLoopAgent + tools + disclosure policy
│   │   ├── ama-context.ts        # work/personal blob search + scoring
│   │   ├── ama-model-config.ts   # env-driven model/provider config
│   │   ├── blog-content.ts       # blog loader (Vercel Blob + gray-matter)
│   │   ├── content.ts            # Edge Config site content (Zod-validated)
│   │   └── resume-context.ts     # resume loader (Vercel Blob)
│   ├── tests/             # Vitest unit tests mirroring lib + api
│   └── package.json
└── .github/workflows/     # Frontend CI: format:check → lint → typecheck → test → build
```

## CI / quality gates

GitHub Actions workflow "Frontend CI" runs on every PR: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. All must pass. There is no pre-commit automation; CI is the enforcement point.

Reviewers also include automated bots (Cursor Bugbot, Gemini) that comment on PRs. Jonathan's workflow is to triage each comment, validate against the current code, and either fix or explain the rejection — not every automated suggestion is correct (e.g. a recent Gemini suggestion to lower the search-term minimum length without an allowlist was rejected because it would have admitted common English two-letter words as search terms).
