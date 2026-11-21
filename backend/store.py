"""SQLite-backed, local-first conversation persistence for VISHU."""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ConversationStore:
    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path).expanduser().resolve()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_messages_conversation
                    ON messages(conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS ix_conversations_updated
                    ON conversations(updated_at);
                """
            )

    def list_conversations(self) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT id, title, created_at, updated_at FROM conversations "
                "ORDER BY updated_at DESC, id DESC"
            ).fetchall()
            return [dict(row) for row in rows]

    def get_conversation(self, conversation_id: str) -> dict | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT id, title, created_at, updated_at FROM conversations WHERE id=?",
                (conversation_id,),
            ).fetchone()
            return dict(row) if row else None

    def create_conversation(self, title: str = "New conversation") -> dict:
        conversation_id = str(uuid.uuid4())
        now = utc_now()
        with self.connection() as db:
            db.execute(
                "INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)",
                (conversation_id, title, now, now),
            )
        return {
            "id": conversation_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
        }

    def list_messages(self, conversation_id: str) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT id, role, content, created_at FROM messages "
                "WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC",
                (conversation_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def model_history(self, conversation_id: str, limit: int = 30) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT role, content FROM ("
                " SELECT rowid, role, content FROM messages WHERE conversation_id=?"
                " ORDER BY rowid DESC LIMIT ?"
                ") ORDER BY rowid ASC",
                (conversation_id, limit),
            ).fetchall()
            return [dict(row) for row in rows]

    def append_exchange(self, conversation_id: str, user_text: str, assistant_text: str) -> None:
        now = utc_now()
        with self.connection() as db:
            db.executemany(
                "INSERT INTO messages(id,conversation_id,role,content,created_at) "
                "VALUES(?,?,?,?,?)",
                [
                    (str(uuid.uuid4()), conversation_id, "user", user_text, now),
                    (str(uuid.uuid4()), conversation_id, "assistant", assistant_text, now),
                ],
            )
            db.execute(
                "UPDATE conversations SET updated_at=? WHERE id=?",
                (now, conversation_id),
            )

    def delete_conversation(self, conversation_id: str) -> bool:
        with self.connection() as db:
            cursor = db.execute(
                "DELETE FROM conversations WHERE id=?", (conversation_id,)
            )
            return cursor.rowcount > 0
