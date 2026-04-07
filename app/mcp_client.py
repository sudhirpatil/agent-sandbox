"""
MCP client proxy layer for the MCP Playground feature.

Uses the raw `mcp` package (not langchain adapters) to support both
Tools and Resources. Each operation opens a fresh session — stateless,
safe, and correct for interactive playground use.
"""

import json
import logging
from contextlib import asynccontextmanager

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _session_for_server(server_row: dict):
    """
    Async context manager that yields an initialised MCP ClientSession
    for the given server row (from the DB).

    Supports three transport types:
      - stdio          : spawns a subprocess
      - sse            : connects to an SSE endpoint
      - streamable_http: connects to a streamable HTTP endpoint
    """
    transport = server_row["transport"]
    config    = json.loads(server_row["config_json"])
    token     = server_row.get("bearer_token")
    headers   = {"Authorization": f"Bearer {token}"} if token else {}

    if transport == "stdio":
        params = StdioServerParameters(
            command=config["command"],
            args=config.get("args", []),
            env=config.get("env") or None,
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session

    elif transport == "sse":
        # Import here to avoid hard dependency if not using SSE
        from mcp.client.sse import sse_client  # noqa: PLC0415

        async with sse_client(config["url"], headers=headers) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session

    elif transport == "streamable_http":
        from mcp.client.streamable_http import streamablehttp_client  # noqa: PLC0415

        async with streamablehttp_client(config["url"], headers=headers) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session

    else:
        raise ValueError(f"Unsupported transport: {transport!r}")


# ── Public API ─────────────────────────────────────────────────────────────────

async def mcp_list_tools(server_row: dict) -> list[dict]:
    """Return list of tools exposed by the server."""
    async with _session_for_server(server_row) as session:
        result = await session.list_tools()
    return [
        {
            "name":        t.name,
            "description": t.description or "",
            "inputSchema": t.inputSchema if hasattr(t, "inputSchema") else {},
        }
        for t in result.tools
    ]


async def mcp_list_resources(server_row: dict) -> list[dict]:
    """Return list of resources exposed by the server."""
    async with _session_for_server(server_row) as session:
        result = await session.list_resources()
    return [
        {
            "uri":         str(r.uri),
            "name":        r.name or "",
            "description": r.description or "",
            "mimeType":    r.mimeType or "",
        }
        for r in result.resources
    ]


async def mcp_call_tool(server_row: dict, tool_name: str, arguments: dict) -> dict:
    """
    Invoke a tool and return normalised output.
    Returns: {"content": [{"type": "text", "text": "..."}], "isError": bool}
    """
    async with _session_for_server(server_row) as session:
        result = await session.call_tool(tool_name, arguments=arguments)

    content_out = []
    for block in result.content:
        if hasattr(block, "text"):
            content_out.append({"type": "text", "text": block.text})
        elif hasattr(block, "data"):
            content_out.append({"type": "image", "data": str(block.data)})
        else:
            content_out.append({"type": "unknown", "data": str(block)})

    return {"content": content_out, "isError": bool(result.isError)}


async def mcp_read_resource(server_row: dict, uri: str) -> dict:
    """
    Read a resource and return normalised contents.
    Returns: {"contents": [{"uri": "...", "type": "text"|"blob", "text": "..."}]}
    """
    async with _session_for_server(server_row) as session:
        result = await session.read_resource(uri)

    contents_out = []
    for c in result.contents:
        if hasattr(c, "text"):
            contents_out.append({"uri": str(c.uri), "type": "text", "text": c.text})
        elif hasattr(c, "blob"):
            contents_out.append({"uri": str(c.uri), "type": "blob", "blob": str(c.blob)})
        else:
            contents_out.append({"uri": str(c.uri), "type": "unknown", "data": str(c)})

    return {"contents": contents_out}
