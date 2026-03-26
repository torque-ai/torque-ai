"""Test fixture: multi-function edit target for agentic loop testing."""

from typing import Any


def parse_name(config: dict[str, Any]) -> str:
    """Parse the name field from config."""
    raw = config.get("name")
    if raw is None:
        raise ValueError("name is required")
    if not isinstance(raw, str):
        raise ValueError("name must be a string")
    return raw.strip()


def parse_priority(config: dict[str, Any]) -> int:
    """Parse the priority field from config."""
    raw = config.get("priority")
    if raw is None:
        return 0
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("priority must be an integer") from exc
    if value < 0:
        raise ValueError("priority must be >= 0")
    return value


def parse_tags(config: dict[str, Any]) -> list[str]:
    """Parse the tags field from config."""
    raw = config.get("tags")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("tags must be a list")
    result = []
    for item in raw:
        if not isinstance(item, str):
            raise ValueError("each tag must be a string")
        stripped = item.strip()
        if stripped:
            result.append(stripped)
    return result


def parse_timeout(config: dict[str, Any]) -> int:
    """Parse the timeout field from config."""
    raw = config.get("timeout")
    if raw is None:
        return 300
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("timeout must be an integer") from exc
    if value <= 0:
        raise ValueError("timeout must be > 0")
    return value


def build_task(config: dict[str, Any]) -> dict[str, Any]:
    """Build a task dict from raw config."""
    return {
        "name": parse_name(config),
        "priority": parse_priority(config),
        "tags": parse_tags(config),
        "timeout": parse_timeout(config),
    }
