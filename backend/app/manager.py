"""
Starts, resumes, retries and cancels runs. Each run executes in a background thread so the API stays
responsive; the frontend polls the run's snapshot.

Runs are held in memory while open (LangGraph's InMemorySaver), because the uploaded files sit in the
graph state and must never be written to disk. A paused run is therefore lost if the server restarts.
Finished runs are saved by the tracker and survive restarts.
"""
from __future__ import annotations

import threading
import uuid

from . import config, llm, tracker
from .agents.common import clean
from .decisions import validate_decisions
from .tracker import Run
from .workflow import CHECKPOINTER, GRAPH
from langgraph.types import Command


class RunError(Exception):
    """A rule of the workflow was broken. `status` is the HTTP status the API should answer with."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def _drive(run: Run, graph_input) -> None:
    cfg = {"configurable": {"thread_id": run.id}}
    try:
        for _ in GRAPH.stream(graph_input, cfg, stream_mode="updates"):
            if run.cancelled:
                return
    except Exception as err:  # noqa: BLE001 - any model, network or config problem is shown to the person
        if not run.cancelled:
            run.fail(f"{type(err).__name__}: {err}")
        return
    if run.cancelled:
        return
    snap = GRAPH.get_state(cfg)
    if snap.next:  # stopped at a human checkpoint
        pending = next((i.value for t in snap.tasks for i in t.interrupts), {})
        run.set_status("paused", pending.get("stage"), pending.get("data"))
    else:
        run.set_status("done")
        CHECKPOINTER.delete_thread(run.id)  # forget the checkpoints, including the uploaded files


def _spawn(run: Run, graph_input) -> None:
    threading.Thread(target=_drive, args=(run, graph_input), daemon=True, name=f"run-{run.id}").start()


def start_run(owner: str, title: str, content_files: list[tuple[str, bytes]],
              reference_files: list[tuple[str, bytes]], pause_source: bool, pause_reference: bool) -> Run:
    if not content_files:
        raise RunError("Add at least one content file to review.", 422)
    if not reference_files:
        raise RunError("Add at least one reference or guideline file.", 422)
    missing = llm.missing_keys()
    if missing:
        raise RunError(f"The server is missing {', '.join(missing)}. Set it, or run with DEMO_MODE=true.", 503)
    if tracker.active_count() >= config.MAX_ACTIVE_RUNS:
        raise RunError("Too many reviews are running right now. Try again in a minute.", 429)

    run = Run(uuid.uuid4().hex[:8], owner, title, pause_source, pause_reference,
              [n for n, _ in content_files], [n for n, _ in reference_files])
    tracker.register(run)

    # The input box is complete the moment the run starts.
    run.nodes["input"]["status"] = "running"
    for c in ("content", "refs", "sent"):
        run.tick("input", c, f"{len(content_files)} file(s)" if c == "content"
                 else f"{len(reference_files)} file(s)" if c == "refs" else None)
    run.finish("input")
    run.log(f"Run started by {owner}: {len(content_files)} content file(s), {len(reference_files)} reference file(s).")

    state = {"content_files": [[n, bytes(d)] for n, d in content_files],
             "reference_files": [[n, bytes(d)] for n, d in reference_files],
             "pause_source": pause_source, "pause_reference": pause_reference}
    _spawn(run, state)
    return run


def _get(run_id: str) -> Run:
    run = tracker.get(run_id)
    if not run:
        raise RunError("Run not found.", 404)
    return run


def resume_run(run_id: str, stage: str, edited: dict | None, decisions: list[dict] | None,
               reviewer: str | None) -> Run:
    """Continue a paused run with the person's (possibly corrected) answer."""
    run = _get(run_id)
    with run.lock:
        if run.status != "paused" or run.stage != stage:
            raise RunError("This run is not waiting for that answer.")
        try:
            if stage in ("source", "reference"):
                if edited is None:
                    raise ValueError("Send the checked claims or facts.")
                answer = clean(edited)  # fail early, before touching the graph, if the edit is invalid
            else:
                findings = (run.pending or {}).get("findings", [])
                validate_decisions(findings, decisions or [])
                answer = {"decisions": decisions, "reviewer": (reviewer or run.owner).strip() or run.owner}
        except ValueError as err:
            raise RunError(str(err), 422) from None
        run.set_status("running")
    run.log(f"Answer received for the {stage} checkpoint.")
    _spawn(run, Command(resume=answer))
    return run


def retry_run(run_id: str) -> Run:
    """Continue from the step that failed (for example after a rate limit that outlasted every retry)."""
    run = _get(run_id)
    with run.lock:
        if run.status != "error":
            raise RunError("This run has not failed.")
        run.set_status("running")
    run.log("Retrying from the step that failed.")
    _spawn(run, None)
    return run


def cancel_run(run_id: str) -> None:
    _get(run_id)
    CHECKPOINTER.delete_thread(run_id)
    tracker.remove(run_id)
