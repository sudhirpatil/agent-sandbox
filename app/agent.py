"""
LangChain 1.x agent supporting Anthropic Claude, OpenAI, and Google Gemini models.
"""

import os
import sys
from pathlib import Path
from typing import AsyncGenerator

from langchain.agents import create_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_openai import ChatOpenAI

MCP_SERVER = str(Path(__file__).parent / "mcp_server.py")

# ── Model catalogue ────────────────────────────────────────────────────────────

ANTHROPIC_MODELS = [
    {"id": "claude-opus-4-6",            "name": "Claude Opus 4.6",       "description": "Most capable",           "provider": "anthropic"},
    {"id": "claude-sonnet-4-6",          "name": "Claude Sonnet 4.6",     "description": "Balanced (recommended)", "provider": "anthropic"},
    {"id": "claude-haiku-4-5-20251001",  "name": "Claude Haiku 4.5",      "description": "Fastest",                "provider": "anthropic"},
    {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet",     "description": "Previous gen",           "provider": "anthropic"},
    {"id": "claude-3-5-haiku-20241022",  "name": "Claude 3.5 Haiku",      "description": "Previous gen · fast",    "provider": "anthropic"},
    {"id": "claude-3-opus-20240229",     "name": "Claude 3 Opus",         "description": "Previous gen",           "provider": "anthropic"},
]

OPENAI_MODELS = [
    {"id": "gpt-4o",               "name": "GPT-4o",          "description": "Flagship multimodal",  "provider": "openai"},
    {"id": "gpt-4o-mini",          "name": "GPT-4o Mini",     "description": "Fast & affordable",    "provider": "openai"},
    {"id": "gpt-4-turbo",          "name": "GPT-4 Turbo",     "description": "High capability",      "provider": "openai"},
    {"id": "o3-mini",              "name": "o3 Mini",         "description": "Advanced reasoning",   "provider": "openai"},
    {"id": "o1-mini",              "name": "o1 Mini",         "description": "Reasoning · fast",     "provider": "openai"},
]

GOOGLE_MODELS = [
    {"id": "gemini-2.0-flash",           "name": "Gemini 2.0 Flash",      "description": "Fast & capable",        "provider": "google"},
    {"id": "gemini-2.0-flash-lite",      "name": "Gemini 2.0 Flash Lite", "description": "Fastest",               "provider": "google"},
    {"id": "gemini-2.5-pro-preview-03-25","name": "Gemini 2.5 Pro",       "description": "Most capable",          "provider": "google"},
    {"id": "gemini-1.5-pro",             "name": "Gemini 1.5 Pro",        "description": "Long context",          "provider": "google"},
    {"id": "gemini-1.5-flash",           "name": "Gemini 1.5 Flash",      "description": "Balanced",              "provider": "google"},
]

ALL_MODELS = ANTHROPIC_MODELS + OPENAI_MODELS + GOOGLE_MODELS

_MODEL_ID_SET = {m["id"] for m in ALL_MODELS}

# Map model-id prefix → required env var
_REQUIRED_KEY: dict[str, str] = {}
for _m in ANTHROPIC_MODELS:
    _REQUIRED_KEY[_m["id"]] = "ANTHROPIC_API_KEY"
for _m in OPENAI_MODELS:
    _REQUIRED_KEY[_m["id"]] = "OPENAI_API_KEY"
for _m in GOOGLE_MODELS:
    _REQUIRED_KEY[_m["id"]] = "GOOGLE_API_KEY"


# ── System prompt ──────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are a helpful AI assistant running inside the Agent Sandbox.
You have access to MCP (Model Context Protocol) tools:

• get_current_datetime — current date and time
• calculate            — evaluate maths expressions (supports Python math module)
• read_file            — read a file from the sandbox directory
• write_file           — write a file to the sandbox directory
• list_sandbox_files   — list files in the sandbox
• web_search           — search the web via DuckDuckGo

Use tools whenever they help you give an accurate or complete answer.
Be concise, clear, and always show your reasoning when using tools.\
"""


# ── LLM factory ───────────────────────────────────────────────────────────────

def get_llm(model_id: str):
    """Return the right LangChain chat model for the given model ID."""
    if model_id in {m["id"] for m in ANTHROPIC_MODELS}:
        return ChatAnthropic(
            model=model_id,
            temperature=0,
            streaming=True,
            max_tokens=4096,
            api_key=os.environ["ANTHROPIC_API_KEY"],
        )
    if model_id in {m["id"] for m in OPENAI_MODELS}:
        kwargs = dict(model=model_id, streaming=True, api_key=os.environ["OPENAI_API_KEY"])
        # Reasoning models don't support temperature
        if not model_id.startswith(("o1", "o3")):
            kwargs["temperature"] = 0
        return ChatOpenAI(**kwargs)
    if model_id in {m["id"] for m in GOOGLE_MODELS}:
        return ChatGoogleGenerativeAI(
            model=model_id,
            temperature=0,
            streaming=True,
            google_api_key=os.environ["GOOGLE_API_KEY"],
        )
    raise ValueError(f"Unknown model ID: {model_id!r}")


def check_api_key(model_id: str) -> str | None:
    """Return an error string if the required API key is missing, else None."""
    key_name = _REQUIRED_KEY.get(model_id)
    if key_name and not os.getenv(key_name):
        return f"{key_name} is not set in your .env file."
    return None


# ── Agent streaming ────────────────────────────────────────────────────────────

async def stream_agent_response(
    message: str,
    model_id: str,
    chat_history: list,
) -> AsyncGenerator[dict, None]:
    """
    Yield structured event dicts to the WebSocket handler:
      {"type": "tool_start",  "tool": ..., "input": ...}
      {"type": "tool_end",    "tool": ..., "output": ...}
      {"type": "token",       "token": ...}
      {"type": "done",        "output": ...}
      {"type": "error",       "message": ...}
    """
    try:
        client = MultiServerMCPClient(
            {
                "sandbox": {
                    "command": sys.executable,
                    "args": [MCP_SERVER],
                    "transport": "stdio",
                }
            }
        )
        tools = await client.get_tools()
        llm = get_llm(model_id)

        agent = create_agent(
            llm,
            tools,
            system_prompt=SYSTEM_PROMPT,
        )

        messages = list(chat_history) + [HumanMessage(content=message)]
        final_output = ""

        async for event in agent.astream_events(
            {"messages": messages},
            config={"recursion_limit": 5},
            version="v2",
        ):
            ename = event["event"]
            edata = event.get("data", {})

            if ename == "on_tool_start":
                yield {
                    "type": "tool_start",
                    "tool": event.get("name", "unknown"),
                    "input": edata.get("input", {}),
                }

            elif ename == "on_tool_end":
                raw = edata.get("output", "")
                # raw may be a ToolMessage, a string, or a list of content blocks
                if hasattr(raw, "content"):
                    content = raw.content
                else:
                    content = raw
                if isinstance(content, list):
                    # Extract text from content-block lists: [{"type":"text","text":"..."}]
                    output_str = "\n".join(
                        item.get("text", str(item)) if isinstance(item, dict) else str(item)
                        for item in content
                    )
                else:
                    output_str = str(content)
                yield {
                    "type": "tool_end",
                    "tool": event.get("name", "unknown"),
                    "output": output_str[:2000],
                }

            elif ename == "on_chat_model_stream":
                chunk = edata.get("chunk")
                if chunk is None:
                    continue
                content = chunk.content
                if isinstance(content, str) and content:
                    yield {"type": "token", "token": content}
                elif isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            text = item.get("text", "")
                            if text:
                                yield {"type": "token", "token": text}

            elif ename == "on_chain_end":
                out = edata.get("output", {})
                if isinstance(out, dict):
                    msgs = out.get("messages", [])
                    if msgs:
                        last = msgs[-1]
                        if hasattr(last, "content") and isinstance(last.content, str):
                            final_output = last.content

        yield {"type": "done", "output": final_output}

    except Exception as exc:
        yield {"type": "error", "message": str(exc)}
