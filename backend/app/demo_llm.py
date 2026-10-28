"""
Offline stand-in for the models, used only when DEMO_MODE=true (demos and automated tests).

It is NOT an AI model. It answers the four agent prompts with simple keyword and number rules so the
whole workflow can be tried without API keys. The UI and decisions.json say so explicitly.
"""
from __future__ import annotations

import json
import re

from langchain_core.messages import AIMessage

STOP = set("the a an and or of to in on for with is are was be it its our your from that this at by as "
           "up we you not no any all each every just than more most very also can will".split())
CLAIM = re.compile(r"\d|#1|\bAcme X\b|\b(?:best|unbeatable|fastest|guarantee\w*|leading|award\w*|certified|faster|better|only|free)\b", re.I)
RULE = re.compile(r"\b(never|always|must|do not|don't|avoid|should|every)\b", re.I)
CONDITION = re.compile(r"terms apply|applies to|valid until|offer ends|limited time|up to", re.I)
HEADER = re.compile(r"^(from|to|date|cc|bcc):", re.I)
QUOTED = re.compile(r"[\"“]([^\"”]+)[\"”]")
NUM = re.compile(r"\$?\d[\d,]*(?:\.\d+)?%?")
TAG = re.compile(r"\s*\[file:\s*([^\]]+?)\s*\]\s*$")


def _sentences(text: str) -> list[str]:
    out = []
    for line in re.split(r"(?<=[.!?])\s+|\n+", text):
        line = line.strip().lstrip("-*• ").strip()
        if len(line) >= 8 and not line.startswith("#") and not HEADER.match(line):
            out.append(line)
    return out


def _stem(w: str) -> str:
    return re.sub(r"(ing|ed|es|s|e)$", "", w)


def _keys(text: str) -> set[str]:
    return {_stem(w) for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 3 and w not in STOP}


def _nums(text: str) -> list[str]:
    return [n.replace(",", "") for n in NUM.findall(text)]


def _docs(content) -> list[tuple[str, str, str]]:
    docs = []
    parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
    for p in parts:
        if isinstance(p, dict) and p.get("type") == "text":
            m = re.match(r"\[([A-Z]+): (.+?)\]\n(.*)", p["text"], re.S)
            if m:
                docs.append((m.group(1).lower(), m.group(2), m.group(3)))
    return docs


def _product(text: str) -> str:
    m = re.search(r"\b[A-Z][a-z]+[A-Z][A-Za-z]+(?: [A-Z0-9]\b)?", text)
    return m.group(0) if m else "unknown"


def _source_extraction(content) -> dict:
    docs = _docs(content)
    statements, context = [], []
    for _, name, text in docs:
        for s in _sentences(text):
            if CLAIM.search(s):
                statements.append(f"{s} [file: {name}]")
            if CONDITION.search(s):
                context.append(s)
    return {"product_name": _product(" ".join(t for _, _, t in docs)), "statements": statements, "context": context}


def _reference_extraction(content) -> dict:
    first = content[0]["text"] if isinstance(content, list) else content
    source = json.loads(first[first.find("{") : first.rfind("}") + 1])
    claim_keys = [_keys(TAG.sub("", s)) for s in source["statements"]]
    claim_has_money = any("$" in s for s in source["statements"])
    statements, context = [], []
    for kind, name, text in _docs(content):
        for s in _sentences(text):
            related = any(len(_keys(s) & k) >= 2 for k in claim_keys) or (claim_has_money and "$" in s)
            if (kind == "guideline" and RULE.search(s)) or (kind != "guideline" and related):
                statements.append(f"{s} [file: {name}]")
                if re.search(r"terms apply|applies to|valid until", s, re.I):
                    context.append(s)
    return {"product_name": source.get("product_name", "unknown"), "statements": statements, "context": context}


def _num_units(text: str) -> list[tuple[str, str]]:
    """[(number, unit)] where unit is '$', '%' or the (singularised) word that follows the number."""
    out = []
    for m in re.finditer(r"(\$?\d[\d,]*(?:\.\d+)?%?)(?:\s+([A-Za-z]+))?", text):
        n = m.group(1).replace(",", "")
        unit = "$" if n.startswith("$") else "%" if n.endswith("%") else re.sub(r"(ies|s)$", "", (m.group(2) or "").lower())
        out.append((n, unit))
    return out


def _is_rule(fact: str) -> bool:
    return bool(RULE.search(fact)) and bool(QUOTED.search(fact) or re.search(r"\b(tone|alt text|hype)\b", fact, re.I))


def _banned(fact: str) -> list[str]:
    return QUOTED.findall(fact)


def _contains(text: str, word: str) -> bool:
    return bool(re.search(rf"(?<!\w){re.escape(word)}(?!\w)", text, re.I))


def _validation(payload: dict) -> dict:
    statement, results = payload["statement"], []
    s_nums = set(_nums(statement))
    for item in payload["facts"]:
        fid, fact = item["fact_id"], TAG.sub("", item["fact"])
        out = {"fact_id": fid, "relation": "unrelated", "attention": "low requirement",
               "issue_types": ["none"], "explanation": "Different topic."}
        if _is_rule(fact):
            hit = [w for w in _banned(fact) if _contains(statement, w)]
            if hit:
                claim = bool(re.search(r"superlative|#1|guarantee|claim", fact, re.I))
                out = {"fact_id": fid, "relation": "contradicts",
                       "attention": "high requirement" if claim else "medium requirement",
                       "issue_types": ["claim"] if claim else ["terminology"],
                       "explanation": f"The statement uses {', '.join(repr(w) for w in hit)}, which the guideline rules out: {fact}"}
        else:
            f_nums = set(_nums(fact))
            related = len(_keys(statement) & _keys(fact)) >= 2 or ("$" in statement and bool(re.search(r"\bprice\b", fact, re.I)))
            if related and s_nums and f_nums and not s_nums <= f_nums:
                only_s, only_f = sorted(s_nums - f_nums), sorted(f_nums - s_nums)
                out = {"fact_id": fid, "relation": "contradicts", "attention": "high requirement",
                       "issue_types": ["fact"],
                       "explanation": f"The statement says {', '.join(only_s) or 'other figures'} but the approved fact says "
                                      f"{', '.join(only_f) or 'other figures'}: {fact}"}
            elif related and not s_nums and f_nums:
                out = {"fact_id": fid, "relation": "partially_supports", "attention": "medium requirement",
                       "issue_types": ["claim"],
                       "explanation": f"The statement drops a condition found in the approved fact: {fact}"}
            elif related:
                out = {"fact_id": fid, "relation": "supports", "attention": "low requirement",
                       "issue_types": ["none"], "explanation": "Matches the approved fact."}
        results.append(out)
    return {"results": results}


def _suggestion(payload: dict) -> dict:
    statement, text, notes, recheck = payload["statement"], payload["statement"], [], False
    issues = payload["issues"]
    if any(i["relation"] == "no_evidence" for i in issues):
        return {"suggested_text": None, "needs_human_input": True,
                "change_summary": "No approved fact or guideline covers this claim, so no safe rewrite exists.",
                "question": "Provide an approved source for this claim, or remove it."}
    for i in issues:
        fact = TAG.sub("", i.get("fact") or "")
        if i["relation"] == "contradicts" and _is_rule(fact):
            correct = re.search(r"\bas ([A-Za-z0-9]+(?: [A-Z0-9])?)\s*,?\s*never", fact)
            for w in [w for w in _banned(fact) if _contains(text, w)]:
                if correct:
                    text = re.sub(rf"(?<!\w){re.escape(w)}(?!\w)", correct.group(1), text, flags=re.I)
                    notes.append(f"{w!r} -> {correct.group(1)!r} (guideline: {fact})")
                else:
                    text = re.sub(rf"(?:\b(?:the|a|an)\s+)?(?<!\w){re.escape(w)}(?!\w)\s*", "", text, flags=re.I)
                    notes.append(f"removed {w!r} (guideline: {fact})")
                    recheck = True
        elif i["relation"] == "contradicts":
            f_pairs, s_nums = _num_units(fact), set(_nums(text))
            for n, unit in _num_units(text):
                if n in set(_nums(fact)):
                    continue
                match = next((fn for fn, fu in f_pairs if fu == unit and fn not in s_nums), None)
                if match:
                    prefix = "up to " if re.search(rf"up to {re.escape(match)}", fact, re.I) and "up to" not in text else ""
                    text = text.replace(n, prefix + match, 1)
                    notes.append(f"{n} -> {prefix}{match} (approved fact: {fact})")
        elif i["relation"] == "partially_supports":
            return {"suggested_text": None, "needs_human_input": True,
                    "change_summary": f"The claim leaves out a condition from the approved fact: {fact}",
                    "question": "Add the missing condition to the claim, or confirm it can be left out."}
    text = re.sub(r"\s{2,}", " ", text).replace(" ,", ",").strip()
    if text == statement:
        return {"suggested_text": None, "needs_human_input": True,
                "change_summary": "The flagged issue cannot be fixed by rewording alone.",
                "question": "Decide how to fix this claim."}
    return {"suggested_text": text, "needs_human_input": recheck,
            "question": "Removing the word may leave the sentence awkward. Check the wording." if recheck else None,
            "change_summary": "Changed: " + "; ".join(notes) + "."}


class DemoLLM:
    name = "demo engine"

    def invoke(self, messages):
        system, human = messages[0].content, messages[1].content
        if "Source Extraction Agent" in system:
            reply = _source_extraction(human)
        elif "Reference Extraction Agent" in system:
            reply = _reference_extraction(human)
        elif "Validation Agent" in system:
            reply = _validation(json.loads(human))
        elif "Suggestion Agent" in system:
            reply = _suggestion(json.loads(human))
        else:
            raise ValueError("demo engine: unknown agent")
        return AIMessage(content=json.dumps(reply, ensure_ascii=False))
