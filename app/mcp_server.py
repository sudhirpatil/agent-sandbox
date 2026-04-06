"""
MCP (Model Context Protocol) server for the AI Agent Sandbox.
Provides tools: datetime, calculator, file read/write, web search.
Run standalone: python app/mcp_server.py
"""

import datetime
import math
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Agent Sandbox Tools")

# Sandbox directory — all file operations are restricted to this folder
SANDBOX_DIR = Path(__file__).parent.parent / "sandbox"
SANDBOX_DIR.mkdir(exist_ok=True)


# ── Tools ──────────────────────────────────────────────────────────────────────

@mcp.tool()
def get_current_datetime() -> str:
    """Get the current date and time in ISO 8601 format."""
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S (%A)")


@mcp.tool()
def calculate(expression: str) -> str:
    """
    Safely evaluate a mathematical expression.

    Args:
        expression: A Python-style math expression, e.g. '2**10', 'sqrt(144)', 'sin(pi/2)'
    """
    allowed = {k: v for k, v in math.__dict__.items() if not k.startswith("_")}
    allowed.update({"abs": abs, "round": round, "min": min, "max": max, "sum": sum})
    try:
        result = eval(expression, {"__builtins__": {}}, allowed)  # noqa: S307
        return f"{expression} = {result}"
    except Exception as exc:
        return f"Error evaluating '{expression}': {exc}"


@mcp.tool()
def read_file(filename: str) -> str:
    """
    Read a file from the sandbox directory.

    Args:
        filename: File name or relative path inside the sandbox (e.g. 'notes.txt')
    """
    target = (SANDBOX_DIR / filename).resolve()
    if not str(target).startswith(str(SANDBOX_DIR.resolve())):
        return "Error: access denied — path escapes sandbox"
    try:
        return target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return f"Error: '{filename}' not found in sandbox"
    except Exception as exc:
        return f"Error reading file: {exc}"


@mcp.tool()
def write_file(filename: str, content: str) -> str:
    """
    Write content to a file in the sandbox directory (creates or overwrites).

    Args:
        filename: File name or relative path inside the sandbox (e.g. 'output.txt')
        content: Text content to write
    """
    target = (SANDBOX_DIR / filename).resolve()
    if not str(target).startswith(str(SANDBOX_DIR.resolve())):
        return "Error: access denied — path escapes sandbox"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"Wrote {len(content)} characters to sandbox/{filename}"
    except Exception as exc:
        return f"Error writing file: {exc}"


@mcp.tool()
def list_sandbox_files() -> str:
    """List all files currently in the sandbox directory."""
    try:
        files = sorted(
            str(f.relative_to(SANDBOX_DIR))
            for f in SANDBOX_DIR.rglob("*")
            if f.is_file() and f.name != ".gitkeep"
        )
        return "\n".join(files) if files else "(sandbox is empty)"
    except Exception as exc:
        return f"Error listing files: {exc}"


@mcp.tool()
def web_search(query: str, max_results: int = 5) -> str:
    """
    Search the web using DuckDuckGo (no API key required).

    Args:
        query: Search terms
        max_results: How many results to return (1–10, default 5)
    """
    try:
        from ddgs import DDGS  # noqa: PLC0415

        max_results = max(1, min(max_results, 10))
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))

        if not results:
            return f"No results found for: {query}"

        lines = []
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r.get('title', 'No title')}")
            lines.append(f"   {r.get('body', '')}")
            lines.append(f"   {r.get('href', '')}")
            lines.append("")
        return "\n".join(lines).strip()

    except Exception as exc:
        return f"Search error: {exc}"


if __name__ == "__main__":
    mcp.run()
