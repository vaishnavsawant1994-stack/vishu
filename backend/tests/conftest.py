"""Isolated test defaults; never access the user's real database or model."""
import os

os.environ.setdefault("VISHU_API_TOKEN", "test-token-for-import")
