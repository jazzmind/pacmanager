"""
Port allocator — adapted from jazzmind/busibox srv/deploy/src/port_allocator.py.

Improvements over the original:
  - filelock so concurrent deploys can't race on the JSON file
  - configurable state file path (off /tmp by default so it survives reboots)
  - async-friendly (file I/O stays sync under a lock; safe with asyncio)
"""

from __future__ import annotations

import json
import os
import socket
from pathlib import Path

from filelock import FileLock

_DEFAULT_STATE_FILE = Path(
    os.environ.get("DEPLOYKIT_PORT_STATE", "/var/lib/deploykit/ports.json")
)
_PORT_RANGE = (4100, 4999)
_RESERVED = {5432, 6379, 8000, 9000, 19530, 3000, 3001, 3002, 3003, 3004, 3005, 3006}


class PortAllocator:
    def __init__(self, state_file: Path | None = None) -> None:
        self._path = state_file or _DEFAULT_STATE_FILE
        self._lock_path = Path(str(self._path) + ".lock")

    def _read(self) -> dict[str, int]:
        if self._path.exists():
            try:
                return json.loads(self._path.read_text())
            except json.JSONDecodeError:
                pass
        return {}

    def _write(self, data: dict[str, int]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(data, indent=2))

    def _port_available(self, port: int) -> bool:
        if port in _RESERVED:
            return False
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False

    async def allocate(self, app_id: str, preferred: int | None = None) -> int:
        with FileLock(str(self._lock_path)):
            assignments = self._read()

            # Reuse existing assignment
            if app_id in assignments:
                return assignments[app_id]

            # Try preferred port first
            candidates = []
            if preferred and preferred not in _RESERVED:
                candidates.append(preferred)
            candidates.extend(range(*_PORT_RANGE))

            allocated_ports = set(assignments.values())
            for port in candidates:
                if port not in allocated_ports and self._port_available(port):
                    assignments[app_id] = port
                    self._write(assignments)
                    return port

        raise RuntimeError(f"No available port in range {_PORT_RANGE}")

    async def release(self, app_id: str) -> None:
        with FileLock(str(self._lock_path)):
            assignments = self._read()
            assignments.pop(app_id, None)
            self._write(assignments)

    async def list_assignments(self) -> dict[str, int]:
        with FileLock(str(self._lock_path)):
            return self._read()
