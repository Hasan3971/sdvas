"""In-memory background jobs with progress (bulk mailbox checks)."""
from __future__ import annotations

import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

from .util import iso, now


class Jobs:
    def __init__(self, keep: int = 30) -> None:
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._keep = keep

    def start(self, kind: str, items: list, work, concurrency: int = 6) -> dict:
        job = {"id": secrets.token_hex(6), "kind": kind, "state": "running", "total": len(items), "done": 0,
               "ok": 0, "failed": 0, "results": [], "started_at": iso(now()), "finished_at": None}
        with self._lock:
            self._jobs[job["id"]] = job
            for old in list(self._jobs)[:-self._keep]:
                self._jobs.pop(old, None)

        def one(item):
            try:
                result = work(item)
            except Exception as exc:  # a failing item must not stop the batch
                result = {"email": str(item), "ok": False, "error": f"{type(exc).__name__}: {exc}"[:160]}
            with self._lock:
                job["done"] += 1
                job["ok" if result.get("ok") else "failed"] += 1
                job["results"].append(result)

        def run():
            with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
                list(pool.map(one, items))
            with self._lock:
                job["state"] = "done"
                job["finished_at"] = iso(now())

        threading.Thread(target=run, name=f"job-{job['id']}", daemon=True).start()
        return self.snapshot(job["id"])

    def snapshot(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job, results=list(job["results"])) if job else None
