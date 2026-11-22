"""Frozen process entry point for the packaged VISHU API."""

from __future__ import annotations

import argparse

import uvicorn

from app import app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    arguments = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=arguments.port, log_level="warning")


if __name__ == "__main__":
    main()
