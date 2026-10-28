"""
Run state: what the frontend graph shows.

Every node of the workflow has a status (idle, running, waiting, done, skipped, error) and a checklist.
Workflow nodes call tick() when a real step finishes, so a box is only ticked after the work happened.
A node's heading gets its tick when finish() is called, i.e. when every box in it is done.

Everything a run produces (source.json, ...) is written to DATA_DIR/runs/<id>/. Uploaded originals are
never written anywhere: they live in memory only until the run ends.
"""
from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config, llm

logger = logging.getLogger("brandguard")

# id, number, role label, title, kind, engine, checklist. The UI lays these out as a snake: 01-04 left to right, 05-08 right to left.
NODE_SPECS: list[dict] = [
    {"id": "input", "n": "01", "role": "Start here", "title": "Input material", "kind": "input", "engine": "person", "checks": [
        ("content", "Source files added"), ("refs", "Reference files added"), ("sent", "Run started")]},
    {"id": "extract_source", "n": "02", "role": "Extraction agent", "title": "Source extraction", "kind": "agent", "engine": "extraction", "checks": [
        ("parse", "Files parsed"), ("model", "Claims isolated"), ("save", "source.json saved")]},
    {"id": "check_source", "n": "03", "role": "Creator review", "title": "Human checkpoint", "kind": "human", "engine": "person", "checks": [
        ("shown", "Claims shown to a person"), ("edits", "Edits applied"), ("confirmed", "Extraction confirmed")]},
    {"id": "extract_reference", "n": "04", "role": "Evidence agent", "title": "Reference matching", "kind": "agent", "engine": "extraction", "checks": [
        ("parse", "Guidelines parsed"), ("model", "Relevant facts retrieved"), ("save", "reference.json saved")]},
    {"id": "check_reference", "n": "05", "role": "Authorised reviewer", "title": "Human checkpoint", "kind": "human", "engine": "person", "checks": [
        ("shown", "Facts shown to a person"), ("edits", "Edits applied"), ("confirmed", "Evidence confirmed")]},
    {"id": "analyze", "n": "06", "role": "Governance agents", "title": "Validate + suggest", "kind": "agent", "engine": "reasoning", "checks": [
        ("pairs", "Claim and fact pairs built"), ("judge", "Claims checked, risks explained"),
        ("draft", "Corrections proposed"), ("guard", "Invented numbers checked"),
        ("save", "validate.json, suggest.json saved")]},
    {"id": "human_review", "n": "07", "role": "Final review", "title": "Human checkpoint", "kind": "human", "engine": "person", "checks": [
        ("shown", "Findings shown to a person"), ("decided", "Every finding decided"), ("save", "decisions.json saved")]},
    {"id": "output", "n": "08", "role": "Decision package", "title": "Output files", "kind": "output", "engine": "none", "checks": [
        ("files", "All files written"), ("sheet", "Decision sheet exported"), ("disclosure", "AI-use disclosure attached")]},
]

FILE_ORDER = ["source.json", "reference.json", "validate.json", "suggest.json", "decisions.json"]


def engine_label(engine: str) -> str:
    if engine == "person":
        return "Human in the loop"
    if engine == "none":
        return "Local files"
    if config.DEMO_MODE:
        return "Demo engine (offline, no AI model)"
    if engine == "extraction":
        return f"OpenRouter · {llm.extraction_model()}"
    return f"Groq · {llm.reasoning_model()}"


def public_specs() -> list[dict]:
    return [{"id": s["id"], "n": s["n"], "role": s["role"], "title": s["title"], "kind": s["kind"],
             "engine": engine_label(s["engine"]),
             "checks": [{"id": c, "label": label} for c, label in s["checks"]]} for s in NODE_SPECS]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Run:
    def __init__(self, run_id: str, owner: str, title: str, pause_source: bool, pause_reference: bool,
                 content_names: list[str], reference_names: list[str]):
        self.id, self.owner, self.title = run_id, owner, title
        self.created = _now()
        self.status = "running"  # running | paused | error | done | interrupted
        self.stage: str | None = None  # which checkpoint a person must answer: source | reference | review
        self.pending: Any = None
        self.error: str | None = None
        self.current: str | None = None
        self.pause_source, self.pause_reference = pause_source, pause_reference
        self.content_names, self.reference_names = content_names, reference_names
        self.nodes = {s["id"]: {"status": "idle", "note": None,
                                "checks": [{"id": c, "done": False, "detail": None} for c, _ in s["checks"]]}
                      for s in NODE_SPECS}
        self.files: dict[str, dict] = {}
        self.logs: list[dict] = []
        self.stats: dict | None = None
        self.disclosure: str | None = None
        self.cancelled = False
        self.lock = threading.RLock()
        self.folder = config.DATA_DIR / "runs" / run_id
        self.folder.mkdir(parents=True, exist_ok=True)

    # ---- node lifecycle (called by the workflow) ------------------------------------------------

    def start(self, node: str, reset: bool = True) -> None:
        with self.lock:
            n = self.nodes[node]
            n["status"], n["note"] = "running", None
            if reset:
                for c in n["checks"]:
                    c["done"], c["detail"] = False, None
            self.current = node
            self._save()

    def tick(self, node: str, check: str, detail: str | None = None, done: bool = True) -> None:
        with self.lock:
            for c in self.nodes[node]["checks"]:
                if c["id"] == check:
                    c["done"] = done
                    if detail is not None:
                        c["detail"] = detail
            self._save()

    def progress(self, node: str, check: str, done: int, total: int, unit: str = "call") -> None:
        self.tick(node, check, f"{done}/{total} {unit}{'' if total == 1 else 's'}", done=total > 0 and done >= total)

    def note(self, node: str, text: str) -> None:
        with self.lock:
            self.nodes[node]["note"] = text
            self._save()

    def wait(self, node: str, stage: str, data: Any) -> None:
        with self.lock:
            self.nodes[node]["status"] = "waiting"
            self.stage, self.pending, self.current = stage, data, node
            self._save()

    def finish(self, node: str) -> None:
        with self.lock:
            n = self.nodes[node]
            for c in n["checks"]:
                c["done"] = True
            n["status"] = "done"
            self.stage, self.pending = None, None
            self._save()

    def skip(self, node: str, note: str) -> None:
        with self.lock:
            n = self.nodes[node]
            if n["status"] in ("idle", "running"):
                n["status"], n["note"] = "skipped", note
            self._save()

    def skip_idle(self, note: str) -> None:
        with self.lock:
            for n in self.nodes.values():
                if n["status"] == "idle":
                    n["status"], n["note"] = "skipped", note
            self._save()

    def fail(self, message: str) -> None:
        with self.lock:
            if self.current:
                self.nodes[self.current]["status"] = "error"
                self.nodes[self.current]["note"] = message
            self.status, self.error = "error", message
            self.stage, self.pending = None, None
            self._save()
        self.log(f"ERROR: {message}")

    def set_status(self, status: str, stage: str | None = None, pending: Any = None) -> None:
        with self.lock:
            self.status, self.stage, self.pending = status, stage, pending
            if status == "running":
                self.error = None
            self._save()

    # ---- files and log -------------------------------------------------------------------------

    def save_file(self, name: str, data: Any, node: str) -> None:
        text = json.dumps(data, indent=2, ensure_ascii=False)
        with self.lock:
            tmp = self.folder / f".{name}.tmp"
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(self.folder / name)
            self.files[name] = {"size": len(text.encode("utf-8")), "node": node}
            self._save()

    def read_file(self, name: str) -> str:
        if name not in self.files:
            raise FileNotFoundError(name)
        return (self.folder / name).read_text(encoding="utf-8")

    def log(self, message: str) -> None:
        logger.info("[%s] %s", self.id, message)
        with self.lock:
            self.logs.append({"t": _now(), "msg": message})
            del self.logs[:-200]
            self._save()

    # ---- views and persistence -----------------------------------------------------------------

    def snapshot(self) -> dict:
        with self.lock:
            ordered = sorted(self.files.items(), key=lambda kv: FILE_ORDER.index(kv[0]) if kv[0] in FILE_ORDER else 99)
            return {
                "id": self.id, "title": self.title, "owner": self.owner, "created": self.created,
                "status": self.status, "stage": self.stage, "pending": self.pending, "error": self.error,
                "current": self.current, "pause_source": self.pause_source, "pause_reference": self.pause_reference,
                "content_names": self.content_names, "reference_names": self.reference_names,
                "nodes": self.nodes,
                "files": [{"name": k, "size": v["size"], "node": v["node"]} for k, v in ordered],
                "log": self.logs[-80:], "stats": self.stats, "disclosure": self.disclosure,
            }

    def summary(self) -> dict:
        with self.lock:
            return {"id": self.id, "title": self.title, "owner": self.owner, "created": self.created,
                    "status": self.status, "stage": self.stage}

    def _save(self) -> None:
        if self.cancelled:
            return
        data = self.snapshot() | {"pending": None}  # claims in flight are not needed on disk
        try:
            tmp = self.folder / ".state.tmp"
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.folder / "state.json")
        except OSError as err:  # a full disk should not kill the run
            logger.warning("could not persist run %s: %s", self.id, err)

    @classmethod
    def from_disk(cls, folder: Path) -> "Run | None":
        try:
            d = json.loads((folder / "state.json").read_text(encoding="utf-8"))
            run = cls.__new__(cls)
            run.id, run.owner, run.title, run.created = d["id"], d["owner"], d["title"], d["created"]
            run.status, run.stage, run.pending, run.error, run.current = d["status"], None, None, d["error"], d["current"]
            run.pause_source, run.pause_reference = d["pause_source"], d["pause_reference"]
            run.content_names, run.reference_names = d["content_names"], d["reference_names"]
            run.nodes, run.logs, run.stats, run.disclosure = d["nodes"], d["log"], d["stats"], d["disclosure"]
            run.files = {f["name"]: {"size": f["size"], "node": f["node"]} for f in d["files"]}
            run.cancelled, run.lock, run.folder = False, threading.RLock(), folder
        except (OSError, ValueError, KeyError):
            return None
        if run.status in ("running", "paused"):
            run.status = "interrupted"
            run.error = ("The server restarted while this run was open. Open runs live in memory only "
                         "(uploaded files are never stored), so start the review again.")
            for n in run.nodes.values():
                if n["status"] in ("running", "waiting"):
                    n["status"], n["note"] = "error", "Interrupted by a server restart."
        return run


# ---- registry --------------------------------------------------------------------------------

RUNS: dict[str, Run] = {}


def get(run_id: str) -> Run | None:
    return RUNS.get(run_id)


def get_run(config_: dict) -> Run:
    """The run a LangGraph node is executing for (thread_id == run id)."""
    return RUNS[config_["configurable"]["thread_id"]]


def register(run: Run) -> None:
    RUNS[run.id] = run


def remove(run_id: str) -> None:
    run = RUNS.pop(run_id, None)
    if run:
        run.cancelled = True
        shutil.rmtree(run.folder, ignore_errors=True)


def list_runs() -> list[dict]:
    return sorted((r.summary() for r in RUNS.values()), key=lambda r: r["created"], reverse=True)


def active_count() -> int:
    return sum(1 for r in RUNS.values() if r.status == "running")


def load_all() -> None:
    """On startup: reload finished runs from disk and purge runs older than RETENTION_DAYS."""
    root = config.DATA_DIR / "runs"
    root.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - config.RETENTION_DAYS * 86400 if config.RETENTION_DAYS > 0 else None
    for folder in root.iterdir():
        if not folder.is_dir():
            continue
        state = folder / "state.json"
        if cutoff and state.exists() and state.stat().st_mtime < cutoff:
            shutil.rmtree(folder, ignore_errors=True)
            continue
        run = Run.from_disk(folder)
        if run:
            RUNS[run.id] = run
