"""Start the pinned local backend; rebuild disposable indexes before serving."""
import importlib.metadata
import os
from pathlib import Path
import runpy
import subprocess
import sys

assert importlib.metadata.version("basic-memory") == "0.23.2", "Hub requires Basic Memory 0.23.2"
cache = Path(os.environ["BASIC_MEMORY_CONFIG_DIR"])
notes = Path(os.environ["BASIC_MEMORY_HOME"])
marker = cache / "hub-index-ready-v1"
if not marker.is_file() or not (cache / "memory.db").is_file():
    # The supported CLI discovers Markdown and rebuilds both search indexes.
    # Keep its human-readable output off the MCP protocol stream.
    subprocess.run(
        [sys.executable, "-I", "-B", "-X", "utf8", "-m", "basic_memory.cli.main", "reindex", "--project", "hub"],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=sys.stderr,
        stderr=sys.stderr,
        timeout=90,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    marker.write_text("0.23.2\n", encoding="utf-8")
sys.argv = ["basic-memory", "mcp", "--transport", "stdio"]
runpy.run_module("basic_memory.cli.main", run_name="__main__")
