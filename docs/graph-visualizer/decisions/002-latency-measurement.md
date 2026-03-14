# ADR-002: Latency Measurement via Redis Stream ID Timestamps

## Status
Accepted

## Context

We want to display per-node processing latency for a running BRAND graph. "Latency"
for a node means the delay between when the node received its most recent input and
when it produced its corresponding output — i.e. how long the node's processing loop
took including any scheduling jitter.

Options considered:

1. Explicit timing streams: require each node to write a timing record to a dedicated
   Redis stream after each processing cycle.
2. Redis stream ID timestamp comparison: infer latency from the wall-clock timestamps
   embedded in the output and input stream entry IDs.
3. Supervisor state stream: check whether the BRAND supervisor already publishes
   per-node timing information.

## Decision

Use **Redis stream ID timestamp comparison** (option 2).

Redis stream entry IDs have the format `{milliseconds}-{sequence}`, where
`milliseconds` is the Unix timestamp in ms at the time of the `XADD` call. This
gives ~1 ms resolution for free, with no changes required to any node.

**Latency formula:**

```
latency_ms(node, t) = out_id_ms(node, t) − max(in_id_ms(node, t))
```

where `out_id_ms` is the ms component of the latest entry ID in the node's primary
output stream, and `in_id_ms` is the same for each input stream (taking the maximum
across all inputs, since the node must have received all inputs before producing output).

**Polling strategy:** The `LatencyService` samples at ~10 Hz using `XREVRANGE count=1`
on each relevant stream. At 10 Hz with ~10 nodes × 3 streams per node = ~30 Redis
calls/second — well within Redis's throughput capacity and negligible compared to
the signal viewer's existing polling load.

**Ring buffer:** 1 200 samples per node (2 minutes at 10 Hz) are retained in memory.
This provides enough data for a stable distribution estimate and a 2-minute running
trace.

## Rationale

- Zero changes to existing nodes.
- 1 ms timestamp resolution is sufficient for typical neural decoding latencies
  (target < 100 ms, typical 5–30 ms).
- `XREVRANGE count=1` is O(1) in Redis and very cheap.
- Works for any node that has at least one detectable input stream and one output
  stream.

## Limitations

- **Within-batch latency invisible**: A node that processes N input samples and writes
  one output entry (e.g. `bin_multiple` binning 20 ms of spikes) produces one output
  ID. The measured latency is the delay of the last output relative to the last input,
  not the delay of each individual sample. This is the correct interpretation for
  decoding pipeline nodes.
- **Batch-to-batch correlation**: We assume the latest output corresponds to the latest
  inputs. For nodes that buffer or reorder, this may be incorrect. In practice BRAND
  nodes process inputs in strict FIFO order.
- **Clock drift**: Redis runs on the same machine as the graph nodes, so all timestamps
  are from the same clock and no drift is possible.
- **Nodes with no output stream**: Pure output nodes (display, socket writer) cannot
  be characterized. They will appear in the graph with a "no latency data" placeholder.

## Alternatives Considered

**Explicit timing streams**: Would give exact per-cycle latency, could be added as a
future enhancement once the heuristic measurement proves insufficient. Requires
coordinated changes to all node implementations.

**Supervisor state stream**: The BRAND supervisor publishes a `supervisor_state`
stream with node health/status information. If this includes per-node timing data,
it would be a more direct source. However, the exact schema of this stream varies
across BRAND versions and may not include sub-millisecond timing. Deferred as a
potential complementary source in Phase 3.
