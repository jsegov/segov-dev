# FastAPI + LangChain Chat Backend with MCP (FastMCP)

A step‑by‑step implementation guide for a production‑ready chat backend using **FastAPI** + **LangChain** with streaming, memory, and **MCP** (Model Context Protocol) integration via **FastMCP**.

---

## TL;DR

* **Transport:** HTTP JSON for non‑stream; **SSE** for token streaming; optional **WebSocket** for duplex features.
* **Core chain:** `ChatPromptTemplate` → `ChatModel` → `StrOutputParser` composed with **LCEL** (Runnable pipeline).
* **Memory:** Use `RunnableWithMessageHistory` + a persistent `ChatMessageHistory` (e.g., Redis) keyed by `session_id`.
* **MCP integration:** Run **FastMCP** servers (stdio or HTTP/SSE) and attach their tools to a LangChain **agent** via `langchain-mcp-adapters`.
* **Observability:** Enable LangSmith or your tracer; log stream events.
* **Deployment:** Containerize; run Uvicorn workers behind a reverse proxy; horizontal scale with a shared message history store.

---

## 0) Prereqs & Versions

* Python 3.11+ (3.12 recommended)
* FastAPI, Uvicorn
* LangChain v1+ and provider packages (e.g., `langchain-openai`, `langchain-anthropic`, etc.)
* Redis (or another persistent chat history backend)
* Streaming libs: `sse-starlette` (SSE); WebSocket is built into FastAPI/Starlette
* MCP: `fastmcp` (server), `langchain-mcp-adapters` (client adapter)

```bash
uv pip install "fastapi>=0.115" "uvicorn[standard]" \
  "langchain>=1.0" langchain-openai langchain-anthropic \
  langchain-redis "sse-starlette>=2.2" \
  fastmcp "langchain-mcp-adapters>=0.1.0"
```

> Set your model provider API key(s) via env vars (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

---

## 1) Minimal Project Layout

```
chat-backend/
  app/
    __init__.py
    main.py              # FastAPI app, routers, lifespan
    schemas.py           # Pydantic models
    chains.py            # Prompt + chain builders
    memory.py            # Chat history + RunnableWithMessageHistory
    sse.py               # SSE helpers
    agent.py             # LangChain agent + MCP tool wiring
    settings.py          # Config (pydantic-settings or environs)
  mcp_servers/
    fileserver.py        # Example FastMCP server (reads local files safely)
  tests/
  Dockerfile
  pyproject.toml
  .env
  README.md
```

---

## 2) FastAPI App Bootstrap (with lifespan)

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.agent import build_mcp_client
from app.routes import router as api_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Lazily construct the MCP client container (stateless sessions per request)
    app.state.mcp_client = build_mcp_client()
    yield
    # Nothing to close for stateless client; close pooled resources here if used

app = FastAPI(title="Chat API", version="1.0.0", lifespan=lifespan)
app.include_router(api_router)
```

---

## 3) Core Chain (LCEL) + Provider

```python
# app/chains.py
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI  # swap for your provider package

SYSTEM_PROMPT = (
    "You are a helpful, terse assistant. Answer clearly."
)

prompt = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_PROMPT),
    ("placeholder", "{history}"),
    ("human", "{input}"),
])

# Streaming-enabled chat model
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.2, streaming=True)

# LCEL pipeline: prompt → model → parser
base_chain = prompt | llm | StrOutputParser()
```

---

## 4) Memory with RunnableWithMessageHistory (Redis example)

```python
# app/memory.py
from typing import Dict
from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_redis.chat_message_history import RedisChatMessageHistory
from app.chains import base_chain

REDIS_URL = "redis://localhost:6379/0"  # from env in prod

_session_cache: Dict[str, BaseChatMessageHistory] = {}

def get_session_history(session_id: str) -> BaseChatMessageHistory:
    # Reuse histories to cut round-trips; safe for single-process dev
    hist = _session_cache.get(session_id)
    if not hist:
        hist = RedisChatMessageHistory(session_id=session_id, url=REDIS_URL)
        _session_cache[session_id] = hist
    return hist

with_history = RunnableWithMessageHistory(
    base_chain,
    get_session_history=get_session_history,
    input_messages_key="input",
    history_messages_key="history",
)
```

> In production, remove the in-process cache (use Redis only) so multiple replicas share history.

---

## 5) API Schemas

```python
# app/schemas.py
from typing import List, Literal, Optional
from pydantic import BaseModel, Field

Role = Literal["system", "user", "assistant"]

class Message(BaseModel):
    role: Role
    content: str

class ChatRequest(BaseModel):
    session_id: str = Field(..., description="Stable user/session key")
    input: str
    stream: bool = False
    model: Optional[str] = None        # allow override per-request
    temperature: Optional[float] = None

class ChatChunk(BaseModel):
    event: str  # token | tool_start | tool_end | final | error
    data: str
```

---

## 6) Non‑Streaming & Streaming Endpoints (SSE)

```python
# app/routes.py
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
from app.schemas import ChatRequest
from app.memory import with_history

router = APIRouter(prefix="/v1")

@router.post("/chat")
async def chat(req: ChatRequest):
    # Non-streaming invoke
    try:
        out = await with_history.ainvoke(
            {"input": req.input},
            config={"configurable": {"session_id": req.session_id}},
        )
        return JSONResponse({"text": out})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    async def gen():
        try:
            async for chunk in with_history.astream(
                {"input": req.input},
                config={"configurable": {"session_id": req.session_id}},
            ):
                # `chunk` is a string thanks to StrOutputParser
                yield {"event": "token", "data": chunk}
        except Exception as e:
            yield {"event": "error", "data": str(e)}
        else:
            yield {"event": "done", "data": req.session_id}

    return EventSourceResponse(gen())
```

> If you need **tool-level** progress, stream **events** from an agent (see §8) using `astream_events` and map them to SSE event names.

---

## 7) Optional: WebSocket (bi‑directional)

```python
# app/ws.py (mount if you need duplex)
from fastapi import APIRouter, WebSocket
from app.memory import with_history

ws_router = APIRouter()

@ws_router.websocket("/ws/chat")
async def ws_chat(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            payload = await ws.receive_json()
            session_id = payload["session_id"]
            user_input = payload["input"]
            async for chunk in with_history.astream(
                {"input": user_input},
                config={"configurable": {"session_id": session_id}},
            ):
                await ws.send_json({"event": "token", "data": chunk})
            await ws.send_json({"event": "done"})
    finally:
        await ws.close()
```

---

## 8) MCP Integration (FastMCP) → LangChain Agent

### 8.1 Build a FastMCP server (example: safe local file reader)

```python
# mcp_servers/fileserver.py
from __future__ import annotations
from pathlib import Path
import os
from fastmcp import FastMCP

ROOT = Path(os.environ.get("FILES_ROOT", ".")).resolve()

mcp = FastMCP("FileServer")

def _safe(path: str) -> Path:
    p = (ROOT / path).resolve()
    if not str(p).startswith(str(ROOT)):
        raise ValueError("Path traversal outside ROOT is not allowed")
    return p

@mcp.tool
def list_dir(path: str = ".", pattern: str = "*") -> list[str]:
    """List files under ROOT/path filtered by glob `pattern`."""
    p = _safe(path)
    return [str(x.name) for x in p.glob(pattern) if x.is_file()]

@mcp.tool
def read_text(path: str, max_bytes: int = 100_000) -> str:
    """Read a UTF‑8 text file under ROOT; limit bytes."""
    p = _safe(path)
    data = p.read_bytes()[:max_bytes]
    return data.decode("utf-8", errors="replace")

if __name__ == "__main__":
    # stdio for local; choose `mcp.run(transport="streamable-http")` to expose over HTTP/SSE
    mcp.run()
```

**Run locally:**

```bash
uv run fastmcp run mcp_servers/fileserver.py
# or: uv run python mcp_servers/fileserver.py
```

### 8.2 Attach MCP tools to a LangChain **agent**

```python
# app/agent.py
from typing import Dict, Any
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

MCP_SERVERS: Dict[str, Any] = {
    "files": {
        "transport": "stdio",
        "command": "python",
        "args": ["mcp_servers/fileserver.py"],
    },
    # Example remote server (HTTP/SSE):
    # "weather": {"transport": "streamable_http", "url": "http://localhost:8000/mcp"},
}

def build_mcp_client() -> MultiServerMCPClient:
    return MultiServerMCPClient(MCP_SERVERS)

async def build_agent(mcp_client: MultiServerMCPClient):
    # Load tools from one or more MCP servers
    async with mcp_client.session("files") as session:
        tools = await load_mcp_tools(session)

    model = ChatOpenAI(model="gpt-4o-mini", streaming=True)
    agent = create_agent(model, tools)
    return agent
```

### 8.3 Stream **agent** events to the client (SSE)

```python
# app/routes_agent.py
from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
from app.agent import build_mcp_client, build_agent

router_agent = APIRouter(prefix="/v1/agent")

@router_agent.post("/chat/stream")
async def agent_stream(body: dict):
    question = body.get("input", "")
    mcp_client = build_mcp_client()
    agent = await build_agent(mcp_client)

    async def gen():
        async for ev in agent.astream_events({
            "messages": [{"role": "user", "content": question}]
        }, version="v2"):
            et = ev["event"]
            if et == "on_chat_model_stream":
                yield {"event": "token", "data": ev["data"]["chunk"].content}
            elif et == "on_tool_start":
                yield {"event": "tool_start", "data": ev["name"]}
            elif et == "on_tool_end":
                yield {"event": "tool_end", "data": ev["name"]}
        yield {"event": "done", "data": "ok"}

    return EventSourceResponse(gen())
```

> When you want memory for agents, wrap the **agent graph** with `RunnableWithMessageHistory` or keep your message history and pass it into the inputs your agent expects.

---

## 9) Observability & Tracing

* Enable LangSmith tracing to debug prompts, tool calls, latencies.
* Log SSE events server‑side (at least info‑level) for incident triage.

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=...   # if using LangSmith
```

---

## 10) Environment Variables

### Chat API Configuration

```env
# Required: OpenAI API key for chat model access
OPENAI_API_KEY=your-openai-api-key-here

# Optional: Model ID override (default: gpt-4o-mini)
CHAT_MODEL_ID=gpt-4o-mini

# MCP Integration Configuration
# URL of the MCP server endpoint (default: http://localhost:8080/mcp)
MCP_SERVER_URL=http://localhost:8080/mcp

# MCP transport type (default: streamable_http)
MCP_TRANSPORT=streamable_http

# Enable MCP tools in chat endpoints (default: true)
# Set to false to disable MCP integration and use basic LLM chain
USE_MCP_IN_CHAT=true
```

### Enabling/Disabling MCP in Chat

- **Enabled (`USE_MCP_IN_CHAT=true`)**: Chat endpoints use a LangChain agent with MCP tools. The agent can automatically use `vector_search` and `doc_get` tools when needed. Falls back to basic chain if MCP connection fails.

- **Disabled (`USE_MCP_IN_CHAT=false`)**: Chat endpoints use a basic LLM chain without tools. Useful for testing or when MCP server is unavailable.

### SSE Event Format

The streaming endpoint (`POST /v1/chat/stream`) returns Server-Sent Events (SSE) with the following format:

```
event: token
data: <chunk>

event: token
data: <chunk>

event: done
data: <session_id>
```

If an error occurs:
```
event: error
data: <error_message>

event: done
data: <session_id>
```

## 11) Security & Multi‑Tenant Notes

* **Auth:** Protect the endpoints with your chosen scheme (bearer/JWT, session cookies). Do **not** expose MCP stdio endpoints directly.
* **MCP Integration:** The chat endpoints connect to the MCP server at the configured URL. Ensure proper network security and authentication for production deployments.
* **File server hardening:** Restrict to an allow‑listed root; sanitize inputs; enforce size/timeouts; never execute files.
* **Rate limiting:** Per session/user; throttle SSE fan‑out.
* **CORS:** Lock down origins in production.
* **Secrets:** Load from env/secret manager; never hardcode keys.

---

## 11) Testing (curl)

SSE stream:

```bash
curl -N -X POST http://localhost:8000/v1/chat/stream \
  -H 'accept: text/event-stream' -H 'content-type: application/json' \
  -d '{"session_id":"demo","input":"Explain LangChain in one sentence"}'
```

Non‑streaming:

```bash
curl -s -X POST http://localhost:8000/v1/chat \
  -H 'content-type: application/json' \
  -d '{"session_id":"demo","input":"Hello"}' | jq
```

---

## 12) Deployment Notes

* **Container:** Use `uvicorn --workers <n> --loop uvloop --http httptools`.
* **Scaling:** Sticky sessions *not* required if history is in Redis; SSE connections are long‑lived—size instances for connection count.
* **Health:** Add `/healthz` and `/readiness` endpoints; prefer graceful shutdown to drain SSE.

**Dockerfile (minimal):**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir -U pip uv
RUN uv pip install --system \
    fastapi "uvicorn[standard]" langchain langchain-openai langchain-redis \
    sse-starlette fastmcp langchain-mcp-adapters
COPY app ./app
COPY mcp_servers ./mcp_servers
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
```

---

## 13) Appendix: Request/Response Contracts

* `POST /v1/chat` → `{ text }`
* `POST /v1/chat/stream` (SSE) → events: `token`, `done`, `error`
* `POST /v1/agent/chat/stream` (SSE) → events include `tool_start`, `tool_end`

**SSE Event Example**

```
event: token
data: partial text here

```

---

## What to customize next

* Swap the model provider (Anthropic, Vertex AI, Groq, etc.)
* Add RAG: retriever node feeding context into the LCEL pipeline
* Promote the MCP file server into a broader toolpack (GitHub, Databases, etc.)
* Add per‑tenant API auth + rate limits and usage metering
