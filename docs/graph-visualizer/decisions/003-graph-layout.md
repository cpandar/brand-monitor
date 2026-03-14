# ADR-003: Left-to-Right Layered DAG Layout (Custom SVG, No Layout Library)

## Status
Accepted

## Context

The graph view needs to render a directed acyclic graph of BRAND nodes. Typical
graphs have 5–20 nodes with relatively sparse connectivity. The layout should
communicate data flow intuitively and not require users to mentally rotate or
interpret an arbitrary force-directed arrangement.

The renderer needs to run entirely in the browser within the existing React/TypeScript
frontend, with minimal new dependencies.

## Decision

Use a **custom left-to-right layered layout** rendered in SVG, with no external
graph layout library.

Layout algorithm:

1. **Topological sort** (Kahn's algorithm) to establish a valid processing order.
2. **Layer assignment**: each node's layer = length of the longest path from any
   source to that node (i.e. critical path depth). This places nodes as far right
   as possible while respecting data flow order, ensuring output nodes appear
   further right than input nodes even when there are multiple paths.
3. **Within-layer vertical ordering**: nodes in the same layer are sorted by a
   single-pass barycentric heuristic (average y-position of their neighbours in
   adjacent layers) to reduce edge crossings. One forward pass is sufficient for
   typical BCI pipeline graphs.
4. **Coordinates**: `x = layer × LAYER_STRIDE_PX`, `y` evenly spaced within layer.
5. **Edges**: cubic Bézier curves from the right-centre of the source node to the
   left-centre of the target node, with stream name labels at the curve midpoint.
6. **Rendering**: pure React + SVG (`<svg>`, `<rect>`, `<path>`, `<text>`). No
   canvas, no D3 selection model — just declarative SVG elements from React state.

D3-scale utilities (`d3-scale`, `d3-array`) may be used for axis ticks in the
latency charts; d3-force and d3-dag are explicitly excluded to keep the bundle small.

## Rationale

- Left-to-right mirrors how engineers describe and think about BRAND pipelines
  (signal acquisition → preprocessing → decoding → output).
- Custom layout is simple enough to implement for graphs of this size (< 20 nodes)
  and avoids pulling in a full layout library (d3-dag is ~40 kB; Cytoscape.js is
  ~250 kB).
- SVG is resolution-independent and easy to make interactive (hover, click, highlight)
  with standard React event handlers.
- The algorithm produces good results for DAGs with clear source-to-sink structure,
  which is the typical shape of a BCI processing pipeline.

## Limitations

- The barycentric heuristic does not guarantee a globally crossing-minimizing layout.
  For the small graphs typical in BRAND this is acceptable.
- Graphs with feedback edges (rare in BRAND during a run, but possible in closed-loop
  configurations) would create cycles that break the topological sort. Mitigation:
  detect back-edges and render them as dashed arcs that curve around the top of the
  graph, rather than allowing them to break the layout.
- Very wide graphs (many sequential stages) may require horizontal scrolling. The SVG
  will be placed inside a scrollable container; the viewport width is not a hard
  constraint.

## Alternatives Considered

**D3 force-directed layout**: Auto-arranges but produces non-deterministic layouts
with no guaranteed left-to-right flow direction. Poor for communicating pipeline
topology.

**Cytoscape.js with dagre layout**: Would produce an excellent layout but adds
~300 kB to the bundle. Overkill for graphs of this size.

**d3-dag (Sugiyama)**: Good algorithm, but the d3-dag API is complex and changes
significantly across versions. The custom implementation requires ~100 lines of
straightforward code for graphs of this size.
