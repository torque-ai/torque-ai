# Variant: Accessibility

## Focus Area

Find accessibility (a11y) issues in UI code and rendered applications.

## Additional Tools

This variant uses `peek_ui` for visual inspection alongside code analysis. Both are needed — code analysis catches missing ARIA attributes, visual inspection catches contrast and layout issues.

## What to Look For

- **Missing ARIA labels** — interactive elements (buttons, inputs, links) without `aria-label`, `aria-labelledby`, or visible text
- **Missing alt text** — images without `alt` attributes
- **Color contrast** — text that may not meet WCAG AA contrast ratios (4.5:1 for normal text, 3:1 for large)
- **Keyboard navigation** — interactive elements not reachable via Tab, missing focus indicators, focus traps
- **Semantic HTML** — divs/spans used instead of semantic elements (button, nav, main, header, etc.)
- **Form labels** — inputs without associated labels (via `for`/`id` or wrapping `<label>`)
- **Dynamic content** — content changes not announced to screen readers (missing `aria-live` regions)
- **Touch targets** — interactive elements smaller than 44x44px
- **Heading hierarchy** — skipped heading levels (h1 → h3), multiple h1 elements
- **Focus management** — modals/dialogs that don't trap focus or return focus on close

## Workflow Override

Combine code analysis and visual inspection:
1. Glob for UI files (*.tsx, *.jsx, *.html, *.xaml, *.vue)
2. Grep for missing patterns: `<img` without `alt=`, `<button` without text/aria-label, `<input` without `<label`
3. Capture rendered UI via `peek_ui` to check visual contrast and layout
4. NEVER use full-screen capture — always by process or title
5. If peek_server is down, do code-only analysis and note that visual checks were skipped

## Severity Guide

- CRITICAL: Entire section inaccessible (no keyboard access, screen reader can't parse)
- HIGH: Missing labels on primary interactive elements, broken focus management
- MEDIUM: Low contrast text, missing ARIA on secondary elements, heading hierarchy issues
- LOW: Minor semantic HTML improvements, touch target slightly small
