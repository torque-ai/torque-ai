# Findings: AutoCodeRover

**Tagline:** Structure-aware autonomous repair agent that localizes before it edits.
**Stars:** 3.1k (GitHub, 2026-04-11)
**Language:** Python

## Feature 1: AST-Indexed Code Search APIs
**What it does:** AutoCodeRover parses the project into class, method, function, and inheritance indexes, then exposes search APIs such as `search_class`, `search_method_in_class`, `search_code_in_file`, and `get_code_around_line`. Those APIs return class signatures, method bodies, or targeted code regions instead of dumping whole files by default.
**Why distinctive:** The repo is treated as a program structure, not as a bag of files plus grep. The class-signature-first behavior is especially sharp because it compresses context on purpose, letting the agent branch into finer method lookups only when needed.
**TORQUE relevance:** HIGH - TORQUE currently leans on file paths, shell, and workflow metadata. AutoCodeRover suggests a better agent surface for Node.js work: symbol-aware retrieval over handlers, workflow nodes, providers, and validators, so repair loops can reason over code entities instead of raw file blobs.

## Feature 2: Spectrum-Based Fault Localization as a Retrieval Prior
**What it does:** When tests are available, AutoCodeRover runs coverage with per-test dynamic context, computes suspiciousness scores with Ochiai, collates suspicious lines, and maps them up to method-level candidates. It then feeds the top suspicious methods into the retrieval stage as hints from an external analysis tool.
**Why distinctive:** SBFL is not used as a hard oracle that directly picks the patch site. It is used to sharpen retrieval, which matters because issue text often mentions distracting reproduction entities rather than the real fix location.
**TORQUE relevance:** HIGH - This is directly applicable to TORQUE's verify-fail recovery problem. Failed workflow runs, targeted tests, or handler traces could seed suspicious modules or functions before a repair agent starts searching, reducing wasted context on irrelevant files.

## Feature 3: Stratified Localize-Then-Fix Loop
**What it does:** AutoCodeRover runs context retrieval in rounds: the search agent selects a small set of APIs, receives results, analyzes whether the context is sufficient, and either requests more retrieval or commits to bug locations. Only after that handoff does a separate patch agent attempt code changes.
**Why distinctive:** This is not a one-shot "read issue, emit patch" system. The workflow explicitly separates localization from patching and makes the model say when it has enough context, which is a cleaner control loop than letting patch generation begin from partial understanding.
**TORQUE relevance:** HIGH - TORQUE could adopt the same staged contract for self-repair flows: localize the failing workflow or provider path first, then hand off typed targets to a patch step. That would make verify-fail recovery less speculative and easier to audit.

## Feature 4: Typed Bug Locations and Hierarchical Context Expansion
**What it does:** Search hits are normalized into `SearchResult` and `BugLocation` objects that carry file, class, method, line span, code, and intended behavior. When a method inside a class is selected, AutoCodeRover can also pull the enclosing class definition and inherited parent implementations as additional context.
**Why distinctive:** The retrieved context is not just prompt text; it becomes a structured intermediate representation that survives into patch generation. The inheritance-aware expansion is a good example of navigation that follows program semantics instead of stopping at the first textual match.
**TORQUE relevance:** HIGH - TORQUE would benefit from passing structured repair targets between stages instead of re-parsing prose at every hop. A typed target object for files, exported functions, routes, or workflow handlers would make edits, verification, and operator review more deterministic.

## Feature 5: Validator-Driven Retry and Candidate Selection
**What it does:** AutoCodeRover first insists on producing an applicable patch format, then runs validation by executing the test suite on the patched program. Failed validation feeds the loop back into patch generation, and the implementation also supports reproducer-plus-review flows and final patch selection across multiple retries and models.
**Why distinctive:** Validation is part of the control flow, not a last-minute scorecard. The system keeps iterating until it finds an applicable, test-passing patch or exhausts retries, and it preserves candidate patches so final selection is not blindly tied to the latest attempt.
**TORQUE relevance:** HIGH - This is the clearest idea for TORQUE to borrow. Provider tasks that fail verification should re-enter a constrained recovery loop with concrete validator feedback, and multi-attempt repairs should retain candidates for final selection instead of assuming retry N is automatically best.

## Verdict
AutoCodeRover's strongest ideas are its symbol-aware retrieval primitives, its explicit localize-then-fix handoff, and its validation-centered retry loop. For TORQUE, the most portable pattern is: use execution evidence to rank suspicious components, navigate the repo with typed code-entity tools, then run minimal repairs inside a verify-fail recovery loop that preserves and selects among candidate patches. The current implementation is Python-specific, but the architecture generalizes well to a Node.js orchestrator if the retrieval layer is rebuilt on top of JavaScript or TypeScript program structure.
