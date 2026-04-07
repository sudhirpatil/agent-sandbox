"""
SQLite persistence layer for chat sessions and messages.
DB file: data/chat.db  (auto-created on first run)
"""

import aiosqlite
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "chat.db"


async def init_db() -> None:
    """Create tables if they don't exist."""
    DB_PATH.parent.mkdir(exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS sessions (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT 'New Chat',
                model      TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role       TEXT NOT NULL CHECK(role IN ('user','ai')),
                content    TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS mcp_servers (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                transport    TEXT NOT NULL CHECK(transport IN ('stdio','sse','streamable_http')),
                config_json  TEXT NOT NULL,
                bearer_token TEXT,
                created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        await db.commit()


# ── Sessions ───────────────────────────────────────────────

async def list_sessions() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, title, model, created_at, updated_at "
            "FROM sessions ORDER BY updated_at DESC"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def create_session(session_id: str, title: str, model: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO sessions (id, title, model) VALUES (?, ?, ?)",
            (session_id, title, model),
        )
        await db.commit()


async def update_session(session_id: str, title: str | None = None, model: str | None = None) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        if title is not None:
            await db.execute(
                "UPDATE sessions SET title=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (title, session_id),
            )
        if model is not None:
            await db.execute(
                "UPDATE sessions SET model=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (model, session_id),
            )
        await db.commit()


async def delete_session(session_id: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        await db.commit()


# ── Messages ───────────────────────────────────────────────

async def get_messages(session_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, session_id, role, content, created_at "
            "FROM messages WHERE session_id=? ORDER BY created_at ASC",
            (session_id,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── MCP Servers ────────────────────────────────────────────

async def list_mcp_servers() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, transport, config_json, created_at "
            "FROM mcp_servers ORDER BY created_at ASC"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_mcp_server(server_id: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, transport, config_json, bearer_token, created_at "
            "FROM mcp_servers WHERE id=?",
            (server_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def create_mcp_server(
    server_id: str,
    name: str,
    transport: str,
    config_json: str,
    bearer_token: str | None,
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO mcp_servers (id, name, transport, config_json, bearer_token) "
            "VALUES (?, ?, ?, ?, ?)",
            (server_id, name, transport, config_json, bearer_token),
        )
        await db.commit()


async def delete_mcp_server(server_id: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM mcp_servers WHERE id=?", (server_id,))
        await db.commit()


async def add_message(session_id: str, role: str, content: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
            (session_id, role, content),
        )
        await db.execute(
            "UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (session_id,),
        )
        await db.commit()
