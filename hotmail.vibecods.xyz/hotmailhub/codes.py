"""Verification-code extraction from mail text."""
from __future__ import annotations

import html
import re

DEFAULT_PATTERNS = [
    r"\b(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b",
    r"(?<!\d)(\d{6})(?!\d)",
]
DEFAULT_MARKERS = "tiktok,verification,verify,код,подтвержд,підтверд,confirm,security code"
_KEYWORDS = re.compile(r"code|код|verif|confirm|security|пароль|підтверд|подтверд", re.I)
_DROP_BLOCKS = re.compile(r"<(script|style|head)[^>]*>.*?</\1>", re.S | re.I)
_BREAKS = re.compile(r"<\s*(br|/p|/div|/tr|/li|/h\d)[^>]*>", re.I)
_TAGS = re.compile(r"<[^>]+>")


def html_to_text(raw: str) -> str:
    cleaned = _DROP_BLOCKS.sub(" ", raw)
    cleaned = _BREAKS.sub("\n", cleaned)
    cleaned = _TAGS.sub(" ", cleaned)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"[ \t\r\f\v\u00a0]+", " ", cleaned)
    return re.sub(r"\n\s*\n+", "\n", cleaned).strip()


def compile_patterns(patterns) -> list[re.Pattern]:
    return [re.compile(p) for p in patterns]


def _keyword_distance(flat: str, start: int, end: int) -> int:
    """Characters between the code and the closest 'code/verify' keyword (999 when none is near)."""
    best = 999
    for keyword in _KEYWORDS.finditer(flat, max(0, start - 70), min(len(flat), end + 40)):
        gap = start - keyword.end() if keyword.end() <= start else keyword.start() - end
        best = min(best, max(0, gap))
    return best


def find_codes(text: str, patterns=None, limit: int = 5) -> list[str]:
    """Codes ordered by closeness to a 'code/verify' keyword, then pattern order, then position."""
    compiled = patterns if patterns and isinstance(patterns[0], re.Pattern) else compile_patterns(patterns or DEFAULT_PATTERNS)
    flat = re.sub(r"\s+", " ", text)
    scored: list[tuple[int, int, int, str]] = []
    for index, pattern in enumerate(compiled):
        for match in pattern.finditer(flat):
            code = match.group(1) if match.groups() else match.group(0)
            scored.append((_keyword_distance(flat, match.start(), match.end()), index, match.start(), code))
    scored.sort()
    result: list[str] = []
    for _distance, _index, _pos, code in scored:
        if code not in result:
            result.append(code)
        if len(result) >= limit:
            break
    return result


def marker_match(markers: str, *fields: str) -> bool:
    words = [w.strip().lower() for w in markers.split(",") if w.strip()]
    if not words:
        return True
    haystack = " ".join(fields).lower()
    return any(word in haystack for word in words)
