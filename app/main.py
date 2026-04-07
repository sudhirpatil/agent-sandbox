"""
FastAPI application — serves the chat UI and WebSocket endpoint.
"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.requests import Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from langchain_core.messages import AIMessage, HumanMessage

load_dotenv()

from app.agent import (  # noqa: E402
    ALL_MODELS,
    ANTHROPIC_MODELS,
    GOOGLE_MODELS,
    OPENAI_MODELS,
    check_api_key,
    stream_agent_response,
)

BASE_DIR = Path(__file__).parent.parent

app = FastAPI(title="AI Agent Sandbox")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


# ── Routes ────────────────────────────────────────────────────────────────────

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


@app.get("/api/models")
async def get_models():
    return JSONResponse({"models": ALL_MODELS})


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

@app.websocket("/ws/chat")
async def chat_ws(websocket: WebSocket):
    await websocket.accept()
    chat_history: list = []

    try:
        while True:
            data = await websocket.receive_json()
            message  = (data.get("message") or "").strip()
            model_id = data.get("model", "claude-sonnet-4-6")

            if not message:
                continue

            # Check that the right API key is present before starting
            key_error = check_api_key(model_id)
            if key_error:
                await websocket.send_json({"type": "error", "message": key_error})
                continue

            await websocket.send_json({"type": "message_start", "model": model_id})

            final_output = ""

            async for event in stream_agent_response(message, model_id, chat_history):
                await websocket.send_json(event)
                if event["type"] == "done":
                    final_output = event.get("output", "")
                elif event["type"] == "error":
                    break

            if final_output:
                chat_history.extend([
                    HumanMessage(content=message),
                    AIMessage(content=final_output),
                ])
                if len(chat_history) > 20:
                    chat_history = chat_history[-20:]

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.error("WebSocket error: %s", exc, exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
