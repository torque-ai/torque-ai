Title: security-guidance: skip pattern matches inside code comments

## Summary

The security reminder hook currently substring-matches risky patterns anywhere in Write/Edit/MultiEdit content. That catches real edits, but it also fires on comments, docstrings, and documentation examples, which creates false positives during normal code-editing sessions.

This patch strips comment syntax before running content-based substring checks. Comment spans are replaced with spaces of the same length so line numbers remain stable for any later diagnostics. Path-based checks, session deduplication, state files, hook entrypoint behavior, and the existing `SECURITY_PATTERNS` list are unchanged.

Scope is intentionally limited to comments only. This does not try to strip string literals, because doing that correctly needs a real tokenizer for each language and is out of scope for this fix.

## Motivating Example

Today, editing a JavaScript file with the exec-paren pattern (`exec(`) inside a double-slash comment can block the edit even though the pattern is only explanatory text:

    // Avoid exec(userInput) in production code.
    const command = ["safe", "argv"];

With this patch, the hook removes the double-slash comment before scanning content-based security patterns, so the `exec(` pattern is ignored because it appears inside a comment.

## Tested

Tested: test_strip_comments.py passes on the 9 cases listed above.

## Filing Checklist

- Fork `anthropics/claude-code-plugins`.
- Apply the patch to `plugins/security-guidance/hooks/security_reminder_hook.py`.
- Add or adapt the standalone `test_strip_comments.py` coverage while preparing the upstream branch.
- Run `python3 test_strip_comments.py`.
- Open the pull request with this title: `security-guidance: skip pattern matches inside code comments`.
