"""Shared schema and helpers for the agents."""
from __future__ import annotations

import json
import re

from pydantic import BaseModel, Field


class Extraction(BaseModel):
    """The JSON format used by both source.json and reference.json."""
    product_name: str = "unknown"
    statements: list[str] = Field(default_factory=list)
    context: list[str] = Field(default_factory=list)


FILE_TAG = re.compile(r"\s*\[file:\s*([^\]]+?)\s*\]\s*$")

MAX_STATEMENTS = 500
MAX_LINE_CHARS = 1500


def split_tag(text: str) -> tuple[str, str | None]:
    """'Price is $5. [file: a.txt]' -> ('Price is $5.', 'a.txt')"""
    m = FILE_TAG.search(text)
    return (text[: m.start()].strip(), m.group(1)) if m else (text.strip(), None)


def as_text(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)


def extract_json(raw: str) -> dict:
    """Pull the first {...} object out of a model reply (models sometimes wrap JSON in prose or fences)."""
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object found in reply")
    return json.loads(raw[start : end + 1])


def clean(data: dict) -> dict:
    """Validate JSON edited by a person; drop blank lines and enforce sane limits."""
    ext = Extraction.model_validate(data)
    ext.statements = [s.strip() for s in ext.statements if s.strip()]
    ext.context = [c.strip() for c in ext.context if c.strip()]
    ext.product_name = ext.product_name.strip() or "unknown"
    if len(ext.statements) > MAX_STATEMENTS:
        raise ValueError(f"Too many statements ({len(ext.statements)}); the limit is {MAX_STATEMENTS}.")
    if any(len(s) > MAX_LINE_CHARS for s in ext.statements + ext.context):
        raise ValueError(f"A line is longer than {MAX_LINE_CHARS} characters. Split it into atomic claims.")
    return ext.model_dump()
