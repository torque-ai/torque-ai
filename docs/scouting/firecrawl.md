# Findings: Firecrawl

**Tagline:** Web data API that turns websites into LLM-ready markdown, JSON, and crawl jobs.
**Stars:** 108k (GitHub, 2026-04-12)
**Language:** TypeScript (68.2%)

## Feature 1: LLM-Ready Markdown Output
**What it does:** Firecrawl's `/scrape` endpoint turns a URL into clean markdown and can also return summary, HTML, raw HTML, links, JSON, and other formats from the same request. The docs position markdown as the default LLM-oriented output and the platform handles JS-rendered pages, proxies, caching, and rate-limit friction behind the scenes.
**Why distinctive:** Many scraping stacks stop at raw HTML and force the application layer to do cleanup, boilerplate stripping, and token reduction. Firecrawl makes markdown a first-class output, which is a better default for agent pipelines that need compact, readable source material immediately.
**TORQUE relevance:** HIGH - Plan 48 is a research-stage problem, so the main win is reducing the distance between "find a page" and "hand a model usable context." Firecrawl could give TORQUE scouting tasks cleaner source payloads without maintaining a custom HTML-to-markdown normalization layer.

## Feature 2: Schema-Driven Structured Extraction
**What it does:** Firecrawl supports structured extraction through both `/scrape` JSON mode and `/extract`, using JSON Schema or typed model schemas plus an optional prompt. It also supports prompt-only extraction when the structure is exploratory and wildcard URL patterns like `/*` when the data spans a whole domain.
**Why distinctive:** The structured mode is integrated into the fetch-and-parse path instead of being a separate ETL pass after scraping. That lets one tool both normalize the page and emit a schema-shaped object, which is a strong fit for typed automations and agent toolchains.
**TORQUE relevance:** HIGH - Plan 48 research runs often need normalized facts, not just markdown blobs. Firecrawl could let TORQUE scouts emit structured artifacts such as feature matrices, pricing tables, or source inventories that are easier to diff, verify, and route into later workflow steps.

## Feature 3: Crawl and Map with Discovery Controls
**What it does:** Firecrawl offers a fast `/map` endpoint for URL discovery and a deeper `/crawl` endpoint for recursive scraping across a site. The crawl flow supports path filters, `maxDiscoveryDepth`, and subdomain or external-link controls, while results can be delivered by polling, WebSocket, or webhook.
**Why distinctive:** The split between fast mapping and bounded crawling is useful because it separates discovery from full-content collection. Instead of committing to an unrestricted spider, you can inventory a site first and then run a constrained crawl over only the sections that matter.
**TORQUE relevance:** HIGH - This is directly useful for Plan 48 because research tasks need scope control to stay cheap and reproducible. TORQUE could use `/map` to generate candidate targets and `/crawl` with depth and path limits to collect bounded source sets for scouting reports.

## Feature 4: PDF and Screenshot-Aware Collection
**What it does:** Firecrawl's scrape surface explicitly handles PDFs, images, and screenshot generation, with screenshot options such as full-page capture, viewport control, and quality settings. It also supports page actions like click, write, press, wait, and screenshot before extraction, which helps with dynamic or gated pages.
**Why distinctive:** This goes beyond text-only scraping by covering non-HTML content and visual evidence in the same API family. That matters when research needs document ingestion, UI-state capture, or proof that a page rendered correctly instead of only returning extracted text.
**TORQUE relevance:** MEDIUM - Not every Plan 48 scout needs screenshots or PDF parsing, but the capability is valuable when source evidence includes downloadable docs or interactive product pages. It would reduce the number of separate tools TORQUE needs for evidence capture during deeper research passes.

## Feature 5: Batch Async Mode for Large URL Sets
**What it does:** Batch Scrape processes an explicit list of URLs concurrently and supports both synchronous and asynchronous execution. The async path returns a job ID for polling, supports per-page webhook events, and allows per-job concurrency tuning with `maxConcurrency`.
**Why distinctive:** It fills the gap between single-page scrape and site-wide crawl: you keep exact control over the target set while still getting concurrent execution and shared job management. It also supports the same structured extraction options, so a batch can return either markdown pages or schema-shaped JSON objects.
**TORQUE relevance:** HIGH - This matches curated research manifests well, where TORQUE already knows which pages it wants to inspect. For Plan 48, Firecrawl could batch documentation pages, pricing pages, changelogs, or repo URLs and hand back normalized results without TORQUE building its own async scraping coordinator.

## Verdict
Firecrawl looks like a strong upstream acquisition layer for TORQUE's Plan 48 research stage because it combines site discovery, LLM-ready markdown, structured extraction, and bounded crawl orchestration behind one API. The biggest value is not orchestration replacement; TORQUE should still own planning, workflow state, and evaluation. The win is collapsing a lot of fragile web collection work into a service that already returns markdown and schema-shaped data in forms that are immediately useful to agents.
