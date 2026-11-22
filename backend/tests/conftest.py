"""Isolated test defaults; never access the user's real database or model."""
import os
import tempfile
from pathlib import Path

os.environ.setdefault("VISHU_API_TOKEN", "test-token-for-import")
_TEST_IMPORT_HOME = tempfile.TemporaryDirectory(prefix="vishu-test-import-")
os.environ.setdefault("VISHU_DB_PATH", str(Path(_TEST_IMPORT_HOME.name) / "import.sqlite3"))
