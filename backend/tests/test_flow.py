import json

from app import config, llm, manager, tracker
from conftest import sample_files, start, wait_for


def accept_all(findings):
    out = []
    for i, f in enumerate(findings):
        if f["suggested_text"]:
            out.append({"index": i, "decision": "accepted", "note": "ok" if f["needs_human_input"] else ""})
        else:
            out.append({"index": i, "decision": "removed", "note": "no approved source"})
    return out


def test_full_flow_with_all_three_checkpoints(client):
    r = start(client)
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert r.json()["nodes"]["input"]["status"] == "done"

    snap = wait_for(client, rid)
    assert (snap["status"], snap["stage"]) == ("paused", "source")
    assert snap["nodes"]["check_source"]["status"] == "waiting"
    assert snap["nodes"]["extract_source"]["status"] == "done"
    assert all(c["done"] for c in snap["nodes"]["extract_source"]["checks"])
    assert snap["nodes"]["extract_reference"]["status"] == "idle"
    assert [f["name"] for f in snap["files"]] == ["source.json"]

    # the person removes one claim and adds one
    edited = snap["pending"]
    edited["statements"] = edited["statements"][1:] + ["Extra claim by hand. [file: added by reviewer]"]
    assert client.post(f"/api/runs/{rid}/resume", json={"stage": "source", "edited": edited}).status_code == 200
    snap = wait_for(client, rid)
    assert snap["stage"] == "reference"
    assert snap["nodes"]["check_source"]["status"] == "done"
    assert "1 removed" in snap["nodes"]["check_source"]["checks"][1]["detail"]
    saved = json.loads(client.get(f"/api/runs/{rid}/files/source.json").text)
    assert saved["statements"] == edited["statements"]  # source.json holds what the person confirmed

    assert client.post(f"/api/runs/{rid}/resume", json={"stage": "reference", "edited": snap["pending"]}).status_code == 200
    snap = wait_for(client, rid)
    assert snap["stage"] == "review"
    assert snap["nodes"]["analyze"]["status"] == "done"  # validate + suggest share box 06
    assert all(c["done"] for c in snap["nodes"]["analyze"]["checks"])
    assert snap["nodes"]["human_review"]["status"] == "waiting"
    findings = snap["pending"]["findings"]
    assert findings and all(f["status"] == "pending_review" for f in findings)
    assert {"source.json", "reference.json", "validate.json", "suggest.json"} <= {f["name"] for f in snap["files"]}

    decisions = accept_all(findings)
    res = client.post(f"/api/runs/{rid}/resume", json={"stage": "review", "decisions": decisions, "reviewer": "Rita"})
    assert res.status_code == 200, res.text
    snap = wait_for(client, rid)
    assert snap["status"] == "done"
    assert all(n["status"] == "done" for n in snap["nodes"].values())
    assert all(c["done"] for n in snap["nodes"].values() for c in n["checks"])
    assert [f["name"] for f in snap["files"]] == ["source.json", "reference.json", "validate.json",
                                                   "suggest.json", "decisions.json"]
    sheet = json.loads(client.get(f"/api/runs/{rid}/files/decisions.json").text)
    assert sheet["reviewed_by"] == "Rita" and sheet["summary"]["findings"] == len(findings)
    assert "DEMO MODE" in sheet["disclosure"]
    assert snap["stats"]["claims"] == len(saved["statements"])


def test_checkpoints_can_be_switched_off(client):
    rid = start(client, pause_source=False, pause_reference=False).json()["id"]
    snap = wait_for(client, rid)
    assert snap["stage"] == "review"  # the decision checkpoint can never be skipped
    assert snap["nodes"]["check_source"]["status"] == "skipped"
    assert snap["nodes"]["check_reference"]["status"] == "skipped"


def test_nothing_flagged_skips_suggest_and_review(client):
    content = [("content_files", ("c.txt", b"Water resistant up to 1.5 meters.\n"))]
    refs = [("reference_files", ("facts.txt", b"Water resistance: IP68, up to 1.5 meters for 30 minutes.\n"))]
    rid = start(client, content=content, refs=refs, pause_source=False, pause_reference=False).json()["id"]
    snap = wait_for(client, rid)
    assert snap["status"] == "done"
    assert snap["nodes"]["analyze"]["status"] == "done"  # validated, nothing needed correcting
    assert snap["nodes"]["human_review"]["status"] == "skipped"
    sheet = json.loads(client.get(f"/api/runs/{rid}/files/decisions.json").text)
    assert sheet["summary"]["findings"] == 0


def test_no_claims_goes_straight_to_output(client):
    content = [("content_files", ("c.txt", b"Hello there, welcome to our page.\n"))]
    rid = start(client, content=content, pause_source=False).json()["id"]
    snap = wait_for(client, rid)
    assert snap["status"] == "done" and snap["nodes"]["extract_reference"]["status"] == "skipped"


def test_decision_rules_are_enforced(client):
    rid = start(client, pause_source=False, pause_reference=False).json()["id"]
    snap = wait_for(client, rid)
    findings = snap["pending"]["findings"]
    url = f"/api/runs/{rid}/resume"

    r = client.post(url, json={"stage": "review", "decisions": []})
    assert r.status_code == 422 and "no decision" in r.json()["detail"]

    kept = [{"index": i, "decision": "kept_original", "note": ""} for i in range(len(findings))]
    assert "note" in client.post(url, json={"stage": "review", "decisions": kept}).json()["detail"]

    edited = [{"index": i, "decision": "edited", "text": ""} for i in range(len(findings))]
    assert "wording" in client.post(url, json={"stage": "review", "decisions": edited}).json()["detail"]

    nosug = next(i for i, f in enumerate(findings) if not f["suggested_text"])
    acc = accept_all(findings)
    acc[nosug] = {"index": nosug, "decision": "accepted"}
    assert "no AI suggestion" in client.post(url, json={"stage": "review", "decisions": acc}).json()["detail"]

    assert client.get(f"/api/runs/{rid}").json()["status"] == "paused"  # rejected answers never move the run
    assert client.post(f"/api/runs/{rid}/resume", json={"stage": "source", "edited": {}}).status_code == 409


def test_failed_step_keeps_progress_and_retries(client, monkeypatch):
    real = llm.make_reasoning_llm
    calls = {"n": 0}

    class Boom:
        def invoke(self, messages):
            calls["n"] += 1
            raise RuntimeError("provider exploded")

    monkeypatch.setattr(llm, "make_reasoning_llm", lambda log=print: Boom())
    rid = start(client, pause_source=False, pause_reference=False).json()["id"]
    snap = wait_for(client, rid)
    # a provider crash inside the agent surfaces as an error on that node, earlier work is kept
    assert snap["status"] == "error" and snap["nodes"]["analyze"]["status"] == "error"
    assert snap["nodes"]["extract_reference"]["status"] == "done"
    assert "provider exploded" in snap["error"]

    monkeypatch.setattr(llm, "make_reasoning_llm", real)
    assert client.post(f"/api/runs/{rid}/retry").status_code == 200
    snap = wait_for(client, rid)
    assert snap["stage"] == "review" and snap["nodes"]["analyze"]["status"] == "done"
    assert client.post(f"/api/runs/{rid}/retry").status_code == 409  # only failed runs can be retried


def test_cancel_removes_run_and_files(client):
    rid = start(client).json()["id"]
    wait_for(client, rid)
    folder = tracker.get(rid).folder
    assert client.delete(f"/api/runs/{rid}").status_code == 204
    assert client.get(f"/api/runs/{rid}").status_code == 404 and not folder.exists()


def test_finished_runs_survive_a_restart(client):
    rid = start(client, pause_source=False, pause_reference=False).json()["id"]
    snap = wait_for(client, rid)
    client.post(f"/api/runs/{rid}/resume", json={"stage": "review", "decisions": accept_all(snap["pending"]["findings"])})
    wait_for(client, rid, ("done",))
    open_id = start(client).json()["id"]
    wait_for(client, open_id)  # paused, in memory only

    tracker.RUNS.clear()
    tracker.load_all()
    assert client.get(f"/api/runs/{rid}").json()["status"] == "done"
    assert client.get(f"/api/runs/{rid}/files/decisions.json").status_code == 200
    reopened = client.get(f"/api/runs/{open_id}").json()
    assert reopened["status"] == "interrupted" and "restarted" in reopened["error"]


def test_upload_rules(client, monkeypatch):
    bad = [("content_files", ("evil.exe", b"MZ"))]
    assert start(client, content=bad).status_code == 415
    empty = [("content_files", ("a.txt", b""))]
    assert start(client, content=empty).status_code == 422
    assert start(client, content=[]).status_code == 422
    monkeypatch.setattr(config, "MAX_FILE_MB", 0)
    assert start(client).status_code == 413
    monkeypatch.setattr(config, "MAX_FILE_MB", 15)
    # path tricks in a file name are reduced to the bare name
    sneaky = [("content_files", ("../../etc/notes.txt", b"Price is $5."))]
    rid = start(client, content=sneaky, refs=sample_files("reference")).json()["id"]
    assert tracker.get(rid).content_names == ["notes.txt"]
    assert client.get(f"/api/runs/{rid}/files/..%2F..%2Fstate.json").status_code == 404
    assert client.get(f"/api/runs/{rid}/files/state.json").status_code == 404  # internal file, not an output


def test_consent_and_keys_are_required_for_real_models(client, monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert start(client, consent=False).status_code == 422
    r = start(client)
    assert r.status_code == 503 and "OPENROUTER_API_KEY" in r.json()["detail"]
    assert client.get("/api/config").json()["missing_keys"] == ["OPENROUTER_API_KEY", "GROQ_API_KEY"]


def test_access_code_gate(client, monkeypatch):
    monkeypatch.setattr(config, "ACCESS_CODE", "s3cret")
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/config").json()["access_required"] is True
    assert client.get("/api/runs").status_code == 401
    assert client.get("/api/runs", headers={"X-Access-Code": "nope"}).status_code == 401
    assert client.get("/api/runs", headers={"X-Access-Code": "s3cret"}).status_code == 200


def test_config_describes_the_graph(client):
    cfg = client.get("/api/config").json()
    assert [n["id"] for n in cfg["nodes"]] == ["input", "extract_source", "check_source", "extract_reference",
                                                "check_reference", "analyze", "human_review", "output"]
    assert cfg["demo"] is True and all(n["checks"] and n["role"] for n in cfg["nodes"])
    s = client.get("/api/samples").json()
    assert len(s["content"]) == 3 and len(s["reference"]) == 2


def test_too_many_active_runs(client, monkeypatch):
    monkeypatch.setattr(config, "MAX_ACTIVE_RUNS", 0)
    assert start(client).status_code == 429
    assert manager.RunError("x").status == 409


def test_first_node_failure_can_be_retried(client, monkeypatch):
    real = llm.make_extraction_llm

    def broken(log=print):
        raise llm.ConfigError("Set OPENROUTER_API_KEY first.")

    monkeypatch.setattr(llm, "make_extraction_llm", broken)
    rid = start(client).json()["id"]
    snap = wait_for(client, rid)
    assert snap["status"] == "error" and snap["nodes"]["extract_source"]["status"] == "error"
    assert "OPENROUTER_API_KEY" in snap["nodes"]["extract_source"]["note"]

    monkeypatch.setattr(llm, "make_extraction_llm", real)
    assert client.post(f"/api/runs/{rid}/retry").status_code == 200
    snap = wait_for(client, rid)
    assert snap["status"] == "paused" and snap["stage"] == "source"
    assert snap["nodes"]["extract_source"]["status"] == "done"
