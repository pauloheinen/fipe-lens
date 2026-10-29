"""Chrome Native Messaging host that starts the local headless reader on demand."""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKER = ROOT / "marketplace_worker.py"
HEALTH_URL = "http://127.0.0.1:8765/health"
LOG_PATH = Path(os.environ.get("LOCALAPPDATA", str(ROOT))) / "MarketplaceFIPELens" / "native_host.log"


def log(message: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as stream:
            stream.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def read_message() -> dict | None:
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return None
    size = struct.unpack("<I", header)[0]
    if size > 1_000_000:
        return None
    raw = sys.stdin.buffer.read(size)
    if len(raw) != size:
        return None
    return json.loads(raw.decode("utf-8"))


def write_message(message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def worker_is_ready() -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=1.5) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def ensure_worker() -> None:
    if not worker_is_ready():
        flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        subprocess.Popen(
            [sys.executable, str(WORKER)],
            cwd=str(ROOT),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=flags,
        )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if worker_is_ready():
            return
        time.sleep(0.25)
    raise RuntimeError("Worker headless nao respondeu em 20 segundos")


def main() -> None:
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        message = read_message()
        log(f"Invoked; args={sys.argv[1:]}; message={message!r}")
        if message is None or message.get("action") != "ensure_worker":
            write_message({"ok": False, "error": "Acao Native Messaging invalida"})
            return
        ensure_worker()
        write_message({"ok": True})
        log("Worker ready")
    except Exception as error:  # Return a useful diagnostic to the extension.
        log(f"ERROR: {error}\n{traceback.format_exc()}")
        write_message({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
