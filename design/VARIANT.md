# Design variant: Phosphor Scope

## Intent

Treat home DNS monitoring like reading a **signal instrument**, not browsing a SaaS admin template. The UI should feel quiet, precise, and “always on” — closer to a rack console or CRT scope than a marketing dashboard.

## Concept name

**Phosphor Scope**

## Visual language

- **Deep navy void** (`#05080c` → `#0a1018`) with a soft green phosphor accent (`#3ddea8`).
- **Mono numerals** for stats, range chips, freshness, and legend — so the eye tracks measurements first.
- **Grid-lined plot beds** under Chart.js canvases (subtle, not gimmicky scanlines).
- **Live pulse** on a single brand LED: the page is a living feed, not a static report.
- **Panel tags** (`SCOPE`, `ERRORS`) as equipment labels — orientation without chrome bloat.
- Active time window glows like a selected dial segment; uptime badge lights green/red with soft bloom.

## Layout

1. Sticky **top bar**: brand + title, data freshness (mono), segmented time dial (30m…3d).
2. **Latency panel** fills most vertical space: heading + server legend, full-width scope chart, history scrubber when needed.
3. **Instrument rail** under the scope: count / avg / p95 / max + uptime capsule — metrics always tied to the visible window.
4. **Error panel** below as a secondary instrument (bar breakdown), not a competing hero.
5. Desktop (≥1000px, tall enough): single-viewport app shell; no page scroll. Mobile: chart-first, stack naturally.

## What makes it distinctive

- Not a card grid of KPI tiles competing with the chart. Metrics sit on an **instrument rail** under the plot — the chart is the product.
- Color is almost monochrome except phosphor and error/warn; series colors from Chart.js stay readable on the grid.
- Typography hierarchy is **measurement-first** (mono values) rather than **brand-first**.
- Avoids purple-gradient “AI dashboard”, heavy sidebars, and generic card chrome.

## Constraints respected

Required element IDs and chart scroll structure remain: `latencyChart`, `latencyChartContainer`, `latencyChartScroll`, `latencyChartInner`, `errorChart`, `statsGrid`, `uptimeBadge`, `rangeSelector`, `lastUpdated`, `latencyLegend`. Range buttons still use `.range-btn` / `.active`.
