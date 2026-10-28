"""
Rules for the human review step, and the decision sheet (decisions.json).

A finding is answered with one of:
    accepted       use the AI suggestion
    edited         use the person's own wording
    kept_original  keep the claim as written (a note explaining why is required)
    removed        drop the claim from the content (a note explaining why is required)
"""
from __future__ import annotations

from datetime import datetime, timezone

DECISIONS = ("accepted", "edited", "kept_original", "removed")


def validate_decisions(findings: list[dict], decisions: list[dict]) -> list[dict]:
    """Check the person's answers against the rules; return one normalised answer per finding, in order."""
    by_index: dict[int, dict] = {}
    for d in decisions:
        i = d.get("index")
        if not isinstance(i, int) or not 0 <= i < len(findings):
            raise ValueError(f"Unknown finding index: {i!r}.")
        if i in by_index:
            raise ValueError(f"Finding #{i + 1} was answered twice.")
        by_index[i] = d

    out = []
    for i, f in enumerate(findings):
        n = i + 1
        d = by_index.get(i)
        if d is None or d.get("decision") not in DECISIONS:
            raise ValueError(f"Finding #{n} has no decision yet.")
        kind = d["decision"]
        text = (d.get("text") or "").strip()
        note = (d.get("note") or "").strip()

        if kind == "accepted":
            if not f.get("suggested_text"):
                raise ValueError(f"Finding #{n} has no AI suggestion to accept. Write your own wording, keep or remove it.")
            if (f.get("warnings") or f.get("needs_human_input")) and not note:
                raise ValueError(f"Finding #{n}: add a note to accept a suggestion that was flagged for a person.")
            final = f["suggested_text"]
        elif kind == "edited":
            if not text:
                raise ValueError(f"Finding #{n}: write the wording you want to use.")
            final = text
        elif kind == "kept_original":
            if not note:
                raise ValueError(f"Finding #{n}: add a note explaining why the original stays.")
            final = f["statement"]
        else:  # removed
            if not note:
                raise ValueError(f"Finding #{n}: add a note explaining why the claim is removed.")
            final = None
        out.append({"index": i, "decision": kind, "final_text": final, "note": note})
    return out


def build_sheet(run, product_name: str, findings: list[dict], decisions: list[dict], reviewer: str) -> dict:
    """The record of what the person decided. This is the only place AI output becomes a decision."""
    answers = validate_decisions(findings, decisions)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for f, a in zip(findings, answers):
        rows.append({
            "statement": f["statement"], "statement_source": f.get("statement_source"),
            "attention": f["attention"], "issue_types": f["issue_types"], "flagged_by": f["flagged_by"],
            "ai_suggestion": f.get("suggested_text"), "ai_change_summary": f.get("change_summary"),
            "ai_warnings": f.get("warnings", []),
            "decision": a["decision"], "final_text": a["final_text"], "note": a["note"],
            "decided_by": reviewer, "decided_at": now,
        })
    counts = {k: sum(r["decision"] == k for r in rows) for k in DECISIONS}
    return {
        "run_id": run.id, "title": run.title, "product_name": product_name,
        "started_by": run.owner, "reviewed_by": reviewer, "completed_at": now,
        "summary": {"findings": len(rows), **counts},
        "disclosure": run.disclosure,
        "decisions": rows,
    }
