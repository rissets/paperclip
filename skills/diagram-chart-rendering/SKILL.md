---
name: diagram-chart-rendering
description: >
  Render diagrams and charts inline in comments using fenced Mermaid blocks (pie, bar/line xychart,
  flowchart, sequence, ER, gantt, state). Use when user asks for a chart, diagram, visualisasi,
  tren, distribusi, perbandingan, flow, or when query results are clearer as a visual than a table.
---

# Diagram & Chart Inline Rendering

The Primbon UI renders any fenced code block tagged `mermaid` as an inline SVG diagram
(see `ui/src/components/MarkdownBody.tsx`). No file upload, image, or external tool is needed:
**just write a ```mermaid block in your Markdown answer.**

Always pair a chart with a short Markdown table or one-line insight so the answer is still useful if
the diagram fails to render.

## 1. Choose the right diagram

| Need | Mermaid type |
| --- | --- |
| Share / composition (≤ 8 slices) | `pie` |
| Category comparison (bar) | `xychart-beta` with `bar` |
| Time-series trend | `xychart-beta` with `line` |
| Process / pipeline / architecture | `flowchart LR` / `flowchart TD` |
| Interaction between systems | `sequenceDiagram` |
| Table relationships | `erDiagram` |
| Lifecycle / status | `stateDiagram-v2` |
| Schedule / timeline | `gantt` |

## 2. Templates

### Pie
````
```mermaid
pie showData title Revenue per Paket (USD)
    "Prepaid" : 1200
    "Postpaid" : 800
```
````

### Bar chart
````
```mermaid
xychart-beta
    title "Top 5 Site by Alarm Count"
    x-axis ["SITE-01", "SITE-02", "SITE-03", "SITE-04", "SITE-05"]
    y-axis "Alarms" 0 --> 100
    bar [90, 72, 55, 40, 31]
```
````

### Line chart (trend)
````
```mermaid
xychart-beta
    title "Net Revenue per Bulan"
    x-axis ["Jan", "Feb", "Mar", "Apr"]
    y-axis "USD" 0 --> 50000
    line [32000, 35500, 41000, 39800]
```
````
Bar and line may be combined in one `xychart-beta` (add both a `bar [...]` and a `line [...]` row).

### Flowchart
````
```mermaid
flowchart LR
    A["Upload CSV"] --> B["Structured Ingestion"]
    B --> C[("ClickHouse")]
    C --> D["Data Agent"]
```
````

## 3. Workflow for data answers

1. Run the query first (`query_structured.py --sql ...`), keep result ≤ 12 categories / ≤ 60 points
   (use `ORDER BY ... LIMIT`, or aggregate by `toStartOfMonth` / `toStartOfDay`).
2. Copy the real numbers from the result into the Mermaid block. **Never invent or round away data.**
3. Output order: key finding sentence → mermaid chart → compact table → provenance note.

## 4. Syntax rules (avoid render errors)

- Quote every label that has spaces or special characters: `["Core Network"]`, `"Q1 2026"`.
- In `xychart-beta`, the number of `x-axis` labels must equal the number of values in `bar`/`line`.
- Numbers only in `bar [...]`/`line [...]` (no `%`, `,`, currency symbols); put units in the axis title.
- Set explicit `y-axis "Label" min --> max` (max slightly above the largest value).
- Pie slices: positive numbers only, label in double quotes.
- Do not use HTML tags in labels. Keep titles under ~60 characters.
- Use one diagram per fenced block; the info string must be exactly `mermaid`.
- If the dataset is too big for a readable chart, aggregate or show Top-N and say so.
