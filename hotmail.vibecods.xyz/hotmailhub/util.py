"""Small shared helpers: time, parsing of loose input, masking."""
from __future__ import annotations

import datetime as dt
import re
import time

UTC = dt.timezone.utc


def now() -> int:
    return int(time.time())


def iso(ts):
    if ts is None:
        return None
    return dt.datetime.fromtimestamp(int(ts), UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value):
    """Epoch seconds/millis or ISO-8601 text -> epoch seconds, else None."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        number = int(value)
    else:
        text = str(value).strip()
        if re.fullmatch(r"-?\d+(\.\d+)?", text):
            number = int(float(text))
        else:
            try:
                parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return int(parsed.timestamp())
    return number // 1000 if number > 10**11 else number


def mask_email(email: str) -> str:
    user, _, domain = email.partition("@")
    return f"{user[:2]}***@{domain}" if domain else f"{email[:2]}***"


def to_int(value, default, low=None, high=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return number


def truthy(value, default=False):
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "y"}
