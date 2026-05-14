# Ollama Task Authoring

When submitting work to Ollama, the task description **is** the instruction set. The wording determines whether the task converges or burns iterations on tool-loop confusion. Ollama models don't have the same instruction-following resilience as Codex or Claude — they need explicit workflow guidance for anything beyond trivial edits.

## For files under ~300 lines

Simple instructions usually work:

> "In file `X`, change `Y` to `Z`."

The model can read the whole file, find the target, and edit in one pass. No special workflow needed.

## For files over ~300 lines

Tell the model the workflow explicitly:

- Use `search_files` first to find the relevant line numbers.
- Use `read_file` with `start_line` and `end_line` to read only the relevant section (e.g., 30-50 lines around the target).
- Use `replace_lines` instead of `edit_file` for the actual change. `replace_lines` is more reliable on large files because it doesn't need to re-emit the whole file.
- Include approximate line numbers when you know them. "Around line 450" is more reliable than a bare symbol search in very large files where `search_files` may miss matches.
- For multiple edits in a large file, list each edit with the function or class name **and** the line number.
- Split multi-function refactors into separate tasks. Ollama is more reliable when each task owns one function (or one file-sized unit of change) than when one task owns a multi-function refactor. The 15-iteration ceiling (20 for complex) makes long task sequences fragile.

## General rules

- Include exact file paths. Ollama can't guess project structure.
- Be specific: "add X after Y" beats "improve the code."
- For files over ~500 lines, prefer one file per task.
- End the task description with **"After making the edits, stop."** to prevent unnecessary verification loops at the tail of execution.

## Why this matters

Full-file reads on large files fill the model's context window and stall inference — the model spends iterations re-reading instead of editing. The line-number workflow keeps each tool call small, leaving headroom for actual reasoning.

This pattern doesn't apply to Codex / Codex-Spark / Claude-CLI providers, which handle large files natively. It's specifically a guardrail for Ollama-hosted models routed through TORQUE.
