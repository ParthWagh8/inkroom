"""
The review as a LangGraph workflow with three human checkpoints.

    extract_source -> check_source [person]
        -> extract_reference -> check_reference [person]
        -> validate -> suggest -> human_review [person] -> output

validate and suggest are two LangGraph nodes but one box (06) in the UI, because they are the two
governance agents. human_review is the final verification (box 07).

Branches
  * no claims found                    -> output (nothing to verify)
  * no approved facts found            -> every claim is flagged "no approved source" without a model call
  * nothing flagged after validation   -> output (suggest and human_review are skipped)

The graph really stops at each checkpoint (LangGraph interrupt) until a person resumes it with their
(possibly corrected) answer. Checkpoints 1 and 2 can be switched off per run; checkpoint 3 cannot.
"""
from __future__ import annotations

import os
from typing import TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from . import decisions as decisions_mod
from . import llm
from .agents.common import Extraction, clean
from .agents.extraction import MAX_CHARS, ReferenceExtractionAgent, SourceExtractionAgent, load_files, total_chars
from .agents.suggestion import SuggestionAgent, group_flagged
from .agents.validation import ValidationAgent, no_evidence_records
from .tracker import get_run


class RunState(TypedDict, total=False):
    content_files: list      # [[name, bytes], ...]  (dropped when the run ends)
    reference_files: list
    pause_source: bool
    pause_reference: bool
    source: dict
    reference: dict
    validate: list
    suggest: list
    decisions: dict


def _docs(files: list, run, label: str):
    docs = load_files(files)
    if total_chars(docs) > MAX_CHARS:
        run.log(f"WARNING: {label} is very large (~{total_chars(docs) // 4:,} tokens); it may exceed the model's context window.")
    return docs


def _edit_summary(before: dict, after: dict) -> str:
    b, a = set(before["statements"]), set(after["statements"])
    return f"{len(a & b)} kept · {len(b - a)} removed · {len(a - b)} added"


# --------------------------------------------------------------------------- #
# Nodes
# --------------------------------------------------------------------------- #


def extract_source(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    run.start("extract_source")
    docs = _docs(state["content_files"], run, "The content")
    run.tick("extract_source", "parse", f"{len(docs)} file(s)")
    source = SourceExtractionAgent(llm.make_extraction_llm(run.log), run.log).run(docs)
    run.tick("extract_source", "model", f"{len(source.statements)} claim(s)")
    run.save_file("source.json", source.model_dump(), "extract_source")
    run.tick("extract_source", "save")
    run.finish("extract_source")
    return {"source": source.model_dump()}


def check_source(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    if not state.get("pause_source"):
        run.skip("check_source", "Switched off for this run.")
        return {}
    run.start("check_source", reset=False)
    run.tick("check_source", "shown", f"{len(state['source']['statements'])} claim(s)")
    run.wait("check_source", "source", state["source"])
    edited = interrupt({"stage": "source", "data": state["source"]})  # the graph stops here until resumed
    cleaned = clean(edited)
    run.tick("check_source", "edits", _edit_summary(state["source"], cleaned))
    run.tick("check_source", "confirmed")
    run.save_file("source.json", cleaned, "extract_source")  # the file now holds what the person confirmed
    run.finish("check_source")
    return {"source": cleaned}


def extract_reference(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    run.start("extract_reference")
    docs = _docs(state["reference_files"], run, "The references")
    run.tick("extract_reference", "parse", f"{len(docs)} file(s)")
    source = Extraction.model_validate(state["source"])
    reference = ReferenceExtractionAgent(llm.make_extraction_llm(run.log), run.log).run(docs, source)
    run.tick("extract_reference", "model", f"{len(reference.statements)} fact(s) and rule(s)")
    run.save_file("reference.json", reference.model_dump(), "extract_reference")
    run.tick("extract_reference", "save")
    run.finish("extract_reference")
    return {"reference": reference.model_dump()}


def check_reference(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    if not state.get("pause_reference"):
        run.skip("check_reference", "Switched off for this run.")
        return {}
    run.start("check_reference", reset=False)
    run.tick("check_reference", "shown", f"{len(state['reference']['statements'])} item(s)")
    run.wait("check_reference", "reference", state["reference"])
    edited = interrupt({"stage": "reference", "data": state["reference"]})
    cleaned = clean(edited)
    run.tick("check_reference", "edits", _edit_summary(state["reference"], cleaned))
    run.tick("check_reference", "confirmed")
    run.save_file("reference.json", cleaned, "extract_reference")
    run.finish("check_reference")
    return {"reference": cleaned}


def validate(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    run.start("analyze")  # box 06 holds both governance agents: this node starts it, suggest() finishes it
    source, reference = Extraction.model_validate(state["source"]), Extraction.model_validate(state["reference"])
    run.tick("analyze", "pairs", f"{len(source.statements) * len(reference.statements)} pair(s)")
    if not reference.statements:
        run.log("No approved facts: every claim is flagged as unverifiable without calling a model.")
        records = no_evidence_records(source)
        run.tick("analyze", "judge", "no model call needed")
    else:
        agent = ValidationAgent(llm.make_reasoning_llm(run.log), log=run.log)
        records = agent.run(source, reference, progress=lambda d, t: run.progress("analyze", "judge", d, t))
        if agent.failed_calls:
            run.note("analyze", f"{agent.failed_calls} model call(s) failed after every retry. "
                                "Those pairs are marked 'unverified' so a person looks at them.")
    run.save_file("validate.json", records, "analyze")
    if not group_flagged(records):  # nothing to correct: the graph skips suggest(), so close the box here
        for c in ("draft", "guard", "save"):
            run.tick("analyze", c, "nothing flagged")
        run.finish("analyze")
    return {"validate": records}


def suggest(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    run.start("analyze", reset=False)  # keep the ticks validate() earned; also correct after a retry
    source, reference = Extraction.model_validate(state["source"]), Extraction.model_validate(state["reference"])
    groups = group_flagged(state["validate"])
    agent = SuggestionAgent(llm.make_reasoning_llm(run.log), log=run.log)
    items = agent.run(groups, source.context, reference.context,
                      progress=lambda d, t: run.progress("analyze", "draft", d, t, unit="claim"))
    warned = sum(bool(i["warnings"]) for i in items)
    run.tick("analyze", "guard", f"{warned} suggestion(s) flagged" if warned else "no invented numbers")
    run.save_file("suggest.json", items, "analyze")
    run.tick("analyze", "save")
    run.finish("analyze")
    return {"suggest": items}


def human_review(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    findings = state["suggest"]
    run.start("human_review", reset=False)
    run.tick("human_review", "shown", f"{len(findings)} finding(s)")
    payload = {"findings": findings}
    run.wait("human_review", "review", payload)
    answer = interrupt({"stage": "review", "data": payload})
    sheet = decisions_mod.build_sheet(run, state["source"]["product_name"], findings,
                                      answer["decisions"], answer.get("reviewer") or run.owner)
    run.tick("human_review", "decided", f"{sheet['summary']['findings']} of {len(findings)} decided")
    run.save_file("decisions.json", sheet, "human_review")
    run.tick("human_review", "save")
    run.finish("human_review")
    return {"decisions": sheet}


def _disclosure(state: RunState, run) -> str:
    from . import config
    if config.DEMO_MODE:
        engine = ("DEMO MODE. No AI model was used and nothing left this server: an offline keyword "
                  "engine produced the extraction, comparison and suggestions, so results are illustrative only.")
    else:
        engine = ("AI-assisted review. The content and reference files were sent to external services: "
                  f"OpenRouter (model {llm.extraction_model()}) to extract claims and approved facts, then "
                  f"Groq (model {llm.reasoning_model()}) to compare them and draft suggestions.")
    checks = [name for name, flag in (("extracted claims", "pause_source"), ("extracted approved facts", "pause_reference"))
              if state.get(flag)]
    human = f" A person checked the {' and the '.join(checks)} before the next step." if checks else ""
    return f"{engine}{human} Suggestions are proposals only: a person makes every decision."


def output(state: RunState, config: RunnableConfig) -> dict:
    run = get_run(config)
    run.start("output")
    run.skip_idle("Not needed: nothing to compare or nothing was flagged.")
    run.disclosure = _disclosure(state, run)

    if not state.get("decisions"):  # nothing was flagged, so there was nothing for a person to decide
        sheet = decisions_mod.build_sheet(run, state["source"]["product_name"], [], [], run.owner)
        sheet["disclosure"] = run.disclosure
        run.save_file("decisions.json", sheet, "output")
    else:
        sheet = state["decisions"]
        sheet["disclosure"] = run.disclosure
        run.save_file("decisions.json", sheet, "human_review")

    source = state["source"]
    reference = state.get("reference") or {"statements": []}
    validate_rows = state.get("validate", [])
    run.stats = {
        "claims": len(source["statements"]), "approved_facts": len(reference["statements"]),
        "flagged": len(state.get("suggest", [])),
        "unverified_pairs": sum(r["relation"] == "unverified" for r in validate_rows),
        **{k: v for k, v in sheet["summary"].items() if k != "findings"},
    }
    run.tick("output", "files", f"{len(run.files)} file(s)")
    run.tick("output", "sheet")
    run.tick("output", "disclosure")
    run.finish("output")
    return {"content_files": [], "reference_files": []}  # drop the uploaded bytes from the state


# --------------------------------------------------------------------------- #
# Graph
# --------------------------------------------------------------------------- #


def after_source(state: RunState) -> str:
    return "extract_reference" if state["source"]["statements"] else "output"


def after_validate(state: RunState) -> str:
    return "suggest" if group_flagged(state["validate"]) else "output"


def build_graph(checkpointer):
    g = StateGraph(RunState)
    for fn in (extract_source, check_source, extract_reference, check_reference, validate, suggest,
               human_review, output):
        g.add_node(fn.__name__, fn)
    g.add_edge(START, "extract_source")
    g.add_edge("extract_source", "check_source")
    g.add_conditional_edges("check_source", after_source, ["extract_reference", "output"])
    g.add_edge("extract_reference", "check_reference")
    g.add_edge("check_reference", "validate")
    g.add_conditional_edges("validate", after_validate, ["suggest", "output"])
    g.add_edge("suggest", "human_review")
    g.add_edge("human_review", "output")
    g.add_edge("output", END)
    return g.compile(checkpointer=checkpointer)


CHECKPOINTER = InMemorySaver()
GRAPH = build_graph(CHECKPOINTER)


def graph_mermaid() -> str:
    return GRAPH.get_graph().draw_mermaid()
