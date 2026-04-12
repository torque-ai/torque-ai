# Findings: GPT Researcher

**Tagline:** Open-source deep research pipeline that plans subtopics, runs parallel web research, and writes cited reports.
**Stars:** 26.4k (GitHub, 2026-04-12)
**Language:** Python

## Feature 1: Planner -> Parallel Research Pipeline
**What it does:** GPT Researcher's core architecture separates planning from execution. The planner turns a query into research questions or outline topics, then execution agents and crawlers gather and summarize evidence for each branch before the writer and publisher synthesize a final report.
**Why distinctive:** The important idea is not just "agent uses search," but explicit decomposition into sub-questions that can run concurrently and later be filtered back into one narrative. That makes the system look more like a research workflow engine than a single chat loop with web browsing attached.
**TORQUE relevance:** HIGH - This maps directly onto Plan 48's need for a durable research stage that fans out from one question into a managed set of evidence-collection tasks. TORQUE already has workflow primitives; GPT Researcher shows what a purpose-built research DAG should feel like at the task level.

## Feature 2: Report-Type Contracts
**What it does:** The repo's `ReportType` enum and pip docs expose multiple output modes instead of a single report template, especially `research_report`, `resource_report`, and `outline_report`. That lets the same engine either synthesize a full cited answer, return a curated resource list, or stop earlier and produce structure for downstream writing.
**Why distinctive:** Most research agents optimize for one "long answer with citations" surface. GPT Researcher makes output intent a first-class parameter, which means planning, evidence selection, and writing can all change based on the artifact you actually want.
**TORQUE relevance:** HIGH - TORQUE research jobs should not always end in the same deliverable. This pattern would let TORQUE differentiate between discovery notes, source inventories, draft outlines, and full scout reports without inventing separate pipelines for each.

## Feature 3: Reviewer/Reviser Editorial Loop
**What it does:** In the repo's LangGraph multi-agent assistant, the research flow expands into a seven-agent editorial team: Chief Editor, Browser, Editor, Researcher, Reviewer, Reviser, Writer, and Publisher. For each outline topic, the reviewer can reject a draft and send it through a reviser loop before the writer assembles the final report and the publisher exports Markdown, PDF, or Docx.
**Why distinctive:** This is a real editorial control loop layered on top of retrieval, not just "self-reflection" as a vague prompt instruction. It treats quality review as a separate role with explicit handoff and conditional branching, which is closer to how human research teams work.
**TORQUE relevance:** MEDIUM - TORQUE does not need this on every scout, but it is a strong pattern for high-stakes research or release evidence where draft quality should be challenged before publication. The main tradeoff is extra latency and model spend, so it fits better as an optional gate than a default path.

## Feature 4: Citation and Source Ledger
**What it does:** GPT Researcher keeps explicit research state through `visited_urls`, accumulated context, and rich source objects, and it exposes getters such as `get_source_urls()`, `get_research_context()`, and `get_research_sources()`. The report pipeline also appends references, so the same run produces both a readable artifact and a machine-usable source ledger.
**Why distinctive:** Many agent demos treat citations as a formatting afterthought. Here, source tracking is part of the runtime contract, which makes it easier to audit where claims came from, reuse the evidence set, and build downstream tooling around the research output.
**TORQUE relevance:** HIGH - This is the strongest fit for TORQUE's scouting and evidence workflows because it closes the gap between "agent wrote a report" and "operator can inspect what grounded it." Plan 48 especially benefits from a first-class source ledger that can be stored, diffed, and attached to later workflow steps.

## Feature 5: Tavily-First Retrieval and Reusable Scraped Context
**What it does:** GPT Researcher defaults to Tavily for web retrieval, supports Tavily Extract as a production scraper, and can store scraped or document-derived chunks in a LangChain vector store for later similarity retrieval. It also supports hybrid runs that combine web results with local documents or MCP-backed data sources.
**Why distinctive:** The retrieval layer is not purely transient. Scraped context can become reusable research memory, which turns one-off browsing into a cacheable evidence base that later reports or downstream agents can query.
**TORQUE relevance:** HIGH - This connects directly to Plan 74's Firecrawl work and suggests a broader acquisition architecture: use a strong retriever or scraper upstream, then persist normalized chunks for later reuse instead of throwing them away after one report. For TORQUE, the key takeaway is the combination of search, extraction, and reusable context in one research loop.

## Verdict
GPT Researcher is more interesting as a complete research pipeline than as a generic "web-enabled agent." The standout ideas are the planner-to-parallel-research pattern, the clean report-type contracts, and the fact that citations and source state remain accessible after the report is written. For TORQUE, it is a good reference for how Plan 48 research could evolve from a single scout step into a staged evidence pipeline, especially when paired with Plan 74-style scraping and a reusable source cache.
