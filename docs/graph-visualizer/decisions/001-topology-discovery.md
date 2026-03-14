# ADR-001: Graph Topology Discovery via supergraph_stream Heuristic

## Status
Accepted

## Context

The BRAND supervisor writes the full graph YAML to a Redis stream called
`supergraph_stream` at graph startup. This is the same mechanism nodes use to
receive their own parameters. The YAML contains all node definitions including
their `parameters` blocks, but does not include an explicit list of which Redis
streams each node reads from or writes to — that information is encoded in the
`parameters` values (e.g. `in_stream: "threshold_values"`), but under
node-specific key names that vary across the codebase.

We need to construct a directed graph of nodes connected by streams without
modifying any existing node code.

## Decision

Topology discovery uses a **two-step heuristic**:

1. Parse the supergraph YAML from `supergraph_stream` to get the full node list
   and their parameters.
2. Enumerate all live Redis stream names via `SCAN`.
3. For each node, walk its `parameters` dict recursively and collect any string
   value (or element of a list value) that exactly matches a live Redis stream name.
   These are the node's **stream candidates**.
4. Build directed edges: if stream `S` appears as a candidate in both node A and
   node B, and no other information is available, add a tentative edge A → S → B.
5. Use the parameter **key name** as a directional hint when present:
   - Keys containing `in`, `input`, `read`, `source` → treat stream as input
   - Keys containing `out`, `output`, `write`, `sink`, `dest` → treat stream as output
   - Ambiguous keys (e.g. `streams`) → inspect whether the stream was found as
     output in another node's unambiguous output key to resolve direction.

## Rationale

- Requires zero changes to existing nodes or YAML files.
- Works for the known set of BRAND nodes (mouseAdapter, bin_multiple,
  wiener_filter, etc.) which follow reasonably consistent naming conventions.
- The supervisor already writes supergraph_stream, so no new Redis writes are needed.

## Limitations and Mitigations

- **False negatives**: A node whose stream parameters use unusual key names may
  not be linked correctly. Mitigation: a future `graph_hints` YAML section (similar
  to `display_hints`) can provide explicit I/O declarations to override the heuristic.
- **False positives**: A parameter that happens to match a stream name by coincidence
  (e.g. a numeric string that collides with a stream name) would create a spurious edge.
  This is unlikely in practice; stream names are descriptive strings.
- **Streams written by non-BRAND processes** (e.g. a C++ task that writes directly
  to Redis) will appear in the stream scan but may not be reachable via any node's
  parameters. These will be shown as unconnected sources at the graph boundary.

## Alternatives Considered

**Explicit I/O declarations in the YAML**: would be fully accurate but requires
modifying every existing graph YAML and potentially every node's YAML template.
Deferred as an optional override mechanism (Phase 3).

**Introspecting node source code**: fragile, language-dependent, and would require
the visualizer to know where each module's code lives at runtime.

**Consumer group inspection**: Redis consumer groups show which streams a consumer
has read from, but BRAND nodes do not use consumer groups (they use `XREAD` with
explicit IDs), so no consumer group metadata is available.
