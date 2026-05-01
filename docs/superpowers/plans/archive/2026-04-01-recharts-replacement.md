# Recharts Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace recharts (402KB / 118KB gzipped) with lightweight SVG chart components (~5KB total), cutting the dashboard bundle nearly in half.

**Architecture:** Create a `dashboard/src/components/charts/` module with focused SVG chart components (LineChart, BarChart, AreaChart, PieChart) that accept the same data shape as recharts but render directly to SVG. Each component is self-contained — no shared charting framework. Views swap imports from `recharts` to `../components/charts`.

**Tech Stack:** React, inline SVG, no external dependencies

**Spec:** Alcove said recharts weighs more than the safety net. Alcove is right.

---

## Current Usage Audit

| View | Components Used | Chart Complexity |
|------|----------------|-----------------|
| `Kanban.jsx` | AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer | Single area chart (7-day activity) |
| `Budget.jsx` | LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend | Bar+Line toggle (daily costs), Pie (provider breakdown) |
| `BatchHistory.jsx` | LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer | Line (completion rate), Bar (task counts), Area (duration) |
| `Models.jsx` | BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer | Single bar chart (model usage) |
| `Providers.jsx` | BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer | Single bar chart (provider stats) |

**All charts are simple**: single-series or dual-series, no animations, no brush/zoom, no custom shapes. SVG replacements are straightforward.

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `dashboard/src/components/charts/SVGLineChart.jsx` | Line chart with optional area fill | Create: ~100 lines |
| `dashboard/src/components/charts/SVGBarChart.jsx` | Vertical bar chart | Create: ~90 lines |
| `dashboard/src/components/charts/SVGPieChart.jsx` | Pie/donut chart | Create: ~80 lines |
| `dashboard/src/components/charts/SVGTooltip.jsx` | Shared hover tooltip | Create: ~40 lines |
| `dashboard/src/components/charts/index.js` | Re-exports | Create: ~5 lines |
| `dashboard/src/views/Kanban.jsx` | Activity area chart | Modify: swap recharts import |
| `dashboard/src/views/Budget.jsx` | Cost bar/line + provider pie | Modify: swap recharts imports |
| `dashboard/src/views/BatchHistory.jsx` | Completion + task + duration charts | Modify: swap recharts imports |
| `dashboard/src/views/Models.jsx` | Model usage bar chart | Modify: swap recharts imports |
| `dashboard/src/views/Providers.jsx` | Provider stats bar chart | Modify: swap recharts imports |
| `package.json` | Dependencies | Modify: remove recharts |

---

## Task 1: SVGTooltip — Shared Hover Tooltip

**Files:**
- Create: `dashboard/src/components/charts/SVGTooltip.jsx`

- [ ] **Step 1: Create the tooltip component**

A lightweight absolute-positioned tooltip that shows on hover. Accepts `x`, `y`, `content` (React node), and `visible` props. Renders as a dark card positioned near the cursor. Used by all chart types.

```jsx
import { memo } from 'react';

export default memo(function SVGTooltip({ x, y, content, visible }) {
  if (!visible || !content) return null;
  return (
    <div
      className="absolute pointer-events-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs text-white shadow-lg z-10"
      style={{ left: x + 12, top: y - 10, whiteSpace: 'nowrap' }}
    >
      {content}
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```
git add dashboard/src/components/charts/SVGTooltip.jsx
git commit -m "feat: lightweight SVG tooltip component"
```

---

## Task 2: SVGLineChart — Line + Area Chart

**Files:**
- Create: `dashboard/src/components/charts/SVGLineChart.jsx`

- [ ] **Step 1: Create the line/area chart**

Props: `data` (array of objects), `dataKey` (string), `xKey` (string), `width`, `height`, `color`, `fill` (boolean for area), `formatX`, `formatY`, `formatTooltip`.

The component:
- Calculates SVG viewBox from data range
- Draws grid lines (dashed, slate-700)
- Draws X/Y axis labels
- Draws the line path via `<polyline>`
- Optionally fills area below the line via `<polygon>`
- Hover over data points shows SVGTooltip with formatted values
- Wraps in a `<div>` with `position: relative` for tooltip positioning
- Auto-sizes to container width via a ResizeObserver or fixed width prop

~100 lines. Replaces: `LineChart`, `Line`, `AreaChart`, `Area`, `XAxis`, `YAxis`, `CartesianGrid`, `Tooltip`, `ResponsiveContainer`.

- [ ] **Step 2: Commit**

```
git add dashboard/src/components/charts/SVGLineChart.jsx
git commit -m "feat: lightweight SVG line/area chart component"
```

---

## Task 3: SVGBarChart — Vertical Bar Chart

**Files:**
- Create: `dashboard/src/components/charts/SVGBarChart.jsx`

- [ ] **Step 1: Create the bar chart**

Props: `data`, `dataKey`, `xKey`, `width`, `height`, `color`, `formatX`, `formatY`, `formatTooltip`, `radius` (corner rounding).

The component:
- Calculates bar width from data length and chart width
- Draws grid lines, X/Y labels
- Draws `<rect>` for each bar with optional rounded top corners
- Hover highlights bar and shows tooltip
- ~90 lines

Replaces: `BarChart`, `Bar`, `XAxis`, `YAxis`, `CartesianGrid`, `Tooltip`, `ResponsiveContainer`.

- [ ] **Step 2: Commit**

```
git add dashboard/src/components/charts/SVGBarChart.jsx
git commit -m "feat: lightweight SVG bar chart component"
```

---

## Task 4: SVGPieChart — Pie/Donut Chart

**Files:**
- Create: `dashboard/src/components/charts/SVGPieChart.jsx`

- [ ] **Step 1: Create the pie chart**

Props: `data` (array with `name` and `value`), `colors` (array or map), `width`, `height`, `innerRadius` (0 for pie, >0 for donut), `formatTooltip`, `showLegend`.

The component:
- Calculates arc segments from data values
- Draws `<path>` elements using SVG arc commands
- Hover highlights segment and shows tooltip
- Optional legend below the chart
- ~80 lines

Replaces: `PieChart`, `Pie`, `Cell`, `Legend`, `Tooltip`, `ResponsiveContainer`.

- [ ] **Step 2: Commit**

```
git add dashboard/src/components/charts/SVGPieChart.jsx
git commit -m "feat: lightweight SVG pie chart component"
```

---

## Task 5: Chart Index + Swap Models.jsx (simplest view)

**Files:**
- Create: `dashboard/src/components/charts/index.js`
- Modify: `dashboard/src/views/Models.jsx`

- [ ] **Step 1: Create index re-exports**

```js
export { default as SVGLineChart } from './SVGLineChart';
export { default as SVGBarChart } from './SVGBarChart';
export { default as SVGPieChart } from './SVGPieChart';
export { default as SVGTooltip } from './SVGTooltip';
```

- [ ] **Step 2: Swap Models.jsx**

Models.jsx uses a single BarChart. Replace the recharts import with the SVG component. Adapt the JSX — instead of nested `<BarChart><Bar/><XAxis/>...` use `<SVGBarChart data={...} dataKey="count" xKey="model" ... />`.

- [ ] **Step 3: Verify build**

```
cd dashboard && npx vite build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```
git add dashboard/src/components/charts/ dashboard/src/views/Models.jsx
git commit -m "feat: swap Models.jsx to lightweight SVG bar chart"
```

---

## Task 6: Swap Providers.jsx

**Files:**
- Modify: `dashboard/src/views/Providers.jsx`

- [ ] **Step 1: Replace recharts import and chart JSX**

Providers.jsx uses a single BarChart. Same pattern as Models.jsx — swap to `SVGBarChart`.

- [ ] **Step 2: Commit**

```
git add dashboard/src/views/Providers.jsx
git commit -m "feat: swap Providers.jsx to lightweight SVG bar chart"
```

---

## Task 7: Swap Kanban.jsx

**Files:**
- Modify: `dashboard/src/views/Kanban.jsx`

- [ ] **Step 1: Replace recharts import and chart JSX**

Kanban.jsx uses an AreaChart for 7-day activity. Swap to `SVGLineChart` with `fill={true}`.

- [ ] **Step 2: Commit**

```
git add dashboard/src/views/Kanban.jsx
git commit -m "feat: swap Kanban.jsx to lightweight SVG area chart"
```

---

## Task 8: Swap Budget.jsx

**Files:**
- Modify: `dashboard/src/views/Budget.jsx`

- [ ] **Step 1: Replace recharts imports and chart JSX**

Budget.jsx uses:
- BarChart/LineChart toggle for daily costs → `SVGBarChart` + `SVGLineChart` with toggle state
- PieChart for provider breakdown → `SVGPieChart`

This is the most complex swap. Read the current chart JSX carefully and map each recharts component to its SVG equivalent.

- [ ] **Step 2: Commit**

```
git add dashboard/src/views/Budget.jsx
git commit -m "feat: swap Budget.jsx to lightweight SVG charts"
```

---

## Task 9: Swap BatchHistory.jsx

**Files:**
- Modify: `dashboard/src/views/BatchHistory.jsx`

- [ ] **Step 1: Replace recharts imports and chart JSX**

BatchHistory.jsx uses LineChart, BarChart, and AreaChart — all three. Swap each to the corresponding SVG component.

- [ ] **Step 2: Commit**

```
git add dashboard/src/views/BatchHistory.jsx
git commit -m "feat: swap BatchHistory.jsx to lightweight SVG charts"
```

---

## Task 10: Remove recharts dependency

**Files:**
- Modify: `dashboard/package.json`

- [ ] **Step 1: Verify no remaining recharts imports**

```
grep -r "from 'recharts'" dashboard/src/ || echo "Clean — no recharts imports remaining"
```

- [ ] **Step 2: Remove the dependency**

```
cd dashboard && npm uninstall recharts
```

- [ ] **Step 3: Final build**

```
cd dashboard && npx vite build 2>&1 | tail -10
```

Expected: No `recharts-*.js` chunk. Total bundle size should drop by ~400KB.

- [ ] **Step 4: Commit**

```
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore: remove recharts dependency — replaced with lightweight SVG charts"
```

---

## Task 11: Verification

- [ ] **Step 1: Compare bundle sizes**

```
cd dashboard && npx vite build 2>&1 | grep -E "\.js|\.css" | head -20
```

Expected: No recharts chunk. Index chunk should be similar size. Total JS should be ~400KB smaller.

- [ ] **Step 2: Visual verification**

Rebuild dashboard, restart TORQUE, check each view with charts:
- Kanban: activity area chart renders
- Budget: bar/line toggle + pie chart render
- BatchHistory: all three chart types render
- Models: bar chart renders
- Providers: bar chart renders

- [ ] **Step 3: Run tests**

```
torque-remote npx vitest run dashboard/ --reporter=verbose 2>&1 | tail -20
```
