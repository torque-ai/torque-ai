#!/usr/bin/env python3
"""Standalone tests for security_reminder_hook.strip_comments."""

import importlib.util
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
HOOK_PATH = SCRIPT_DIR / "security_reminder_hook.py"

spec = importlib.util.spec_from_file_location("security_reminder_hook", HOOK_PATH)
security_reminder_hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(security_reminder_hook)

strip_comments = security_reminder_hook.strip_comments


def run_case(label, check):
    print(label)
    check()


def main():
    run_case(
        "a. .js double-slash comment trigger is stripped",
        lambda: assert_not_contains(
            strip_comments("const safe = true;\n// exec(\n", "example.js"),
            "exec(",
            "line-comment trigger should be stripped from .js files",
        ),
    )

    run_case(
        "b. .js slash-star block comment trigger is stripped",
        lambda: assert_not_contains(
            strip_comments("const safe = true;\n/* eval( */\n", "example.js"),
            "eval(",
            "block-comment trigger should be stripped from .js files",
        ),
    )

    run_case(
        "c. .js top-level trigger is preserved",
        lambda: assert_contains(
            strip_comments("const value = exec(command);\n", "example.js"),
            "exec(",
            "top-level trigger should be preserved in .js files",
        ),
    )

    run_case(
        "d. .py hash line-comment trigger is stripped",
        lambda: assert_not_contains(
            strip_comments("value = 1\n# os.system\n", "example.py"),
            "os.system",
            "hash-comment trigger should be stripped from .py files",
        ),
    )

    run_case(
        "e. .py shebang on line 1 is preserved",
        lambda: assert_contains(
            strip_comments("#!/usr/bin/env python3\n# pickle\n", "example.py"),
            "#!/usr/bin/env python3",
            "line-1 shebang should be preserved in .py files",
        ),
    )

    run_case(
        "f. .html block comment trigger is stripped",
        lambda: assert_not_contains(
            strip_comments("<main></main>\n<!-- innerHTML= -->\n", "example.html"),
            "innerHTML=",
            "HTML comment trigger should be stripped from .html files",
        ),
    )

    run_case(
        "g. unknown extension is unchanged",
        lambda: assert_equal(
            strip_comments("// exec(\n", "example.xyz"),
            "// exec(\n",
            "unknown extensions should be returned unchanged",
        ),
    )

    run_case(
        "h. empty file_path is unchanged",
        lambda: assert_equal(
            strip_comments("// exec(\n", ""),
            "// exec(\n",
            "empty file_path should return content unchanged",
        ),
    )

    run_case(
        "i. line-number preservation for 3-line block comment",
        lambda: assert_equal(
            strip_comments("before\n/* one\ntwo\nthree */\nafter\n", "example.js").count(
                "\n"
            ),
            "before\n/* one\ntwo\nthree */\nafter\n".count("\n"),
            "stripping a 3-line block comment should preserve newline count",
        ),
    )

    print("all passed")


def assert_contains(content, needle, message):
    assert needle in content, message


def assert_not_contains(content, needle, message):
    assert needle not in content, message


def assert_equal(actual, expected, message):
    assert actual == expected, f"{message}: expected {expected!r}, got {actual!r}"


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(f"FAILED: {error}", file=sys.stderr)
        sys.exit(1)
