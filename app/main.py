"""
FastAPI application — serves the chat UI, REST session API, and WebSocket endpoint.
"""

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.requests import Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from langchain_core.messages import AIMessage, HumanMessage

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

from app.agent import (  # noqa: E402
    ALL_MODELS,
    ANTHROPIC_MODELS,
    GOOGLE_MODELS,
    OPENAI_MODELS,
    check_api_key,
    stream_agent_response,
)
from app.database import (  # noqa: E402
    add_message,
    create_mcp_server,
    create_session,
    delete_mcp_server,
    delete_session,
    get_messages,
    get_mcp_server,
    init_db,
    list_mcp_servers,
    list_sessions,
    update_session,
)
from app.mcp_client import (  # noqa: E402
    mcp_call_tool,
    mcp_list_resources,
    mcp_list_tools,
    mcp_read_resource,
)

BASE_DIR = Path(__file__).parent.parent


# ── App startup ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    logger.info("SQLite database initialised")
    yield

app = FastAPI(title="AI Agent Sandbox", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates") 


# ── Pages ──────────────────────────────────────────────────────────────────────

@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "anthropic_models": ANTHROPIC_MODELS,
            "openai_models":    OPENAI_MODELS,
            "google_models":    GOOGLE_MODELS,
        },
    )


# ── Session REST API ───────────────────────────────────────────────────────────

@app.get("/api/sessions")
async def api_list_sessions():
    return JSONResponse(await list_sessions())


@app.post("/api/sessions")
async def api_create_session(request: Request):
    body = await request.json()
    await create_session(body["id"], body.get("title", "New Chat"), body["model"])
    return JSONResponse({"ok": True})


@app.patch("/api/sessions/{session_id}")
async def api_update_session(session_id: str, request: Request):
    body = await request.json()
    await update_session(session_id, title=body.get("title"), model=body.get("model"))
    return JSONResponse({"ok": True})


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    await delete_session(session_id)
    return JSONResponse({"ok": True})


@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    return JSONResponse(await get_messages(session_id))


# ── Misc API ───────────────────────────────────────────────────────────────────

@app.get("/api/models")
async def get_models():
    return JSONResponse({"models": ALL_MODELS})


# ── MCP Server REST API ────────────────────────────────────────────────────────

@app.get("/api/mcp-servers")
async def api_list_mcp_servers():
    return JSONResponse(await list_mcp_servers())


@app.post("/api/mcp-servers")
async def api_create_mcp_server(request: Request):
    body = await request.json()
    transport = body.get("transport", "")
    if transport not in ("stdio", "sse", "streamable_http"):
        return JSONResponse({"error": "transport must be stdio, sse, or streamable_http"}, status_code=400)
    config = body.get("config", {})
    if transport == "stdio" and "command" not in config:
        return JSONResponse({"error": "stdio transport requires 'command' in config"}, status_code=400)
    if transport in ("sse", "streamable_http") and "url" not in config:
        return JSONResponse({"error": f"{transport} transport requires 'url' in config"}, status_code=400)
    server_id = body.get("id") or f"mcp-{uuid4().hex[:8]}"
    await create_mcp_server(
        server_id=server_id,
        name=body.get("name", "MCP Server"),
        transport=transport,
        config_json=json.dumps(config),
        bearer_token=body.get("bearer_token") or None,
    )
    return JSONResponse({"ok": True, "id": server_id})


@app.delete("/api/mcp-servers/{server_id}")
async def api_delete_mcp_server(server_id: str):
    await delete_mcp_server(server_id)
    return JSONResponse({"ok": True})


@app.post("/api/mcp-servers/{server_id}/connect")
async def api_mcp_connect(server_id: str):
    row = await get_mcp_server(server_id)
    if not row:
        return JSONResponse({"error": "Server not found"}, status_code=404)
    try:
        tools = await mcp_list_tools(row)
        try:
            resources = await mcp_list_resources(row)
        except Exception:
            resources = []
        return JSONResponse({"tools": tools, "resources": resources})
    except Exception as exc:
        logger.error("MCP connect error for %s: %s", server_id, exc, exc_info=True)
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.post("/api/mcp-servers/{server_id}/tools/{tool_name}/call")
async def api_mcp_call_tool(server_id: str, tool_name: str, request: Request):
    row = await get_mcp_server(server_id)
    if not row:
        return JSONResponse({"error": "Server not found"}, status_code=404)
    body = await request.json()
    arguments = body.get("arguments", {})
    try:
        result = await mcp_call_tool(row, tool_name, arguments)
        return JSONResponse(result)
    except Exception as exc:
        logger.error("MCP tool call error for %s/%s: %s", server_id, tool_name, exc, exc_info=True)
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.post("/api/mcp-servers/{server_id}/resources/read")
async def api_mcp_read_resource(server_id: str, request: Request):
    row = await get_mcp_server(server_id)
    if not row:
        return JSONResponse({"error": "Server not found"}, status_code=404)
    body = await request.json()
    uri = body.get("uri", "")
    if not uri:
        return JSONResponse({"error": "uri is required"}, status_code=400)
    try:
        result = await mcp_read_resource(row, uri)
        return JSONResponse(result)
    except Exception as exc:
        logger.error("MCP resource read error for %s: %s", server_id, exc, exc_info=True)
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "keys": {
            "anthropic": bool(os.getenv("ANTHROPIC_API_KEY")),
            "openai":    bool(os.getenv("OPENAI_API_KEY")),
            "google":    bool(os.getenv("GOOGLE_API_KEY")),
        },
    }


# ── WebSocket chat ─────────────────────────────────────────────────────────────

# In-memory LangChain history cache — reloaded from DB after a server restart
_lc_history: dict[str, list] = {}


async def _get_lc_history(session_id: str) -> list:
    """Return cached LangChain message list, loading from DB if needed."""
    if session_id not in _lc_history:
        msgs = await get_messages(session_id)
        _lc_history[session_id] = [
            HumanMessage(content=m["content"]) if m["role"] == "user"
            else AIMessage(content=m["content"])
            for m in msgs
        ]
    return _lc_history[session_id]


@app.websocket("/ws/chat")
async def chat_ws(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            data       = await websocket.receive_json()
            message    = (data.get("message") or "").strip()
            model_id   = data.get("model", "gpt-4o-mini")
            session_id = data.get("session_id", "")

            if not message or not session_id:
                continue

            key_error = check_api_key(model_id)
            if key_error:
                await websocket.send_json({"type": "error", "message": key_error})
                continue

            await websocket.send_json({"type": "message_start", "model": model_id})

            # Persist user message
            await add_message(session_id, "user", message)

            chat_history = await _get_lc_history(session_id)
            # Append the new user message for this turn
            chat_history.append(HumanMessage(content=message))

            final_output = ""

            async for event in stream_agent_response(message, model_id, chat_history[:-1]):
                await websocket.send_json(event)
                if event["type"] == "done":
                    final_output = event.get("output", "")
                elif event["type"] == "error":
                    # Roll back the user message we optimistically appended
                    chat_history.pop()
                    break

            if final_output:
                # Persist AI response and update cache
                await add_message(session_id, "ai", final_output)
                chat_history.append(AIMessage(content=final_output))
                # Keep cache bounded (last 20 messages = 10 turns)
                if len(chat_history) > 20:
                    _lc_history[session_id] = chat_history[-20:]

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.error("WebSocket error: %s", exc, exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
