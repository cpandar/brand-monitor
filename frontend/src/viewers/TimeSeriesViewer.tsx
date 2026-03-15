import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { DataBatch, ViewerConfig } from '../types'

// Keep up to MAX_BUFFER_SECS of history so expanding the window reveals real past data.
const MAX_BUFFER_SECS = 60

interface Props {
  config: ViewerConfig
  registerDataHandler: (stream: string, field: string, handler: (batch: DataBatch) => void) => () => void
  windowSecs?: number
}

export function TimeSeriesViewer({ config, registerDataHandler, windowSecs = 5 }: Props) {
  const containerRef  = useRef<HTMLDivElement>(null)
  const plotRef       = useRef<uPlot | null>(null)
  const windowSecsRef = useRef(windowSecs)
  windowSecsRef.current = windowSecs

  const allFields    = [config.field, ...(config.extraFields ?? [])]
  const isMultiField = allFields.length > 1

  // For multi-field every field is 1-channel; for single-field use fieldInfo.
  const nChannels = isMultiField ? allFields.length : config.fieldInfo.n_channels
  const hints     = config.fieldInfo.hints

  const maxPoints = Math.max(
    6000,
    Math.ceil((config.fieldInfo.approx_rate_hz || 1000) * MAX_BUFFER_SECS * 1.5),
  )

  // Aligned ring buffer: shared timestamps + one array per channel/field
  const bufRef = useRef<{ ts: number[]; channels: number[][] }>(
    { ts: [], channels: [] },
  )

  // For multi-field: pending map keyed by timestamp to align arrivals from different fields.
  // BRAND fields from the same stream share Redis entry IDs → identical timestamps,
  // so entries flush immediately once both field frames arrive.
  const pendingRef = useRef<Map<number, Map<string, number>>>(new Map())

  // Keep windowSecsRef in sync and nudge uPlot immediately
  useEffect(() => {
    windowSecsRef.current = windowSecs
    if (plotRef.current && bufRef.current.ts.length > 0) {
      const buf = bufRef.current
      const now = buf.ts[buf.ts.length - 1]
      plotRef.current.setScale('x', { min: now - windowSecs, max: now })
    }
  }, [windowSecs])

  // Initialize uPlot once per field set / channel count
  useEffect(() => {
    if (!containerRef.current) return

    const channelLabels = hints.channel_labels
    const series: uPlot.Series[] = [
      {},
      ...Array.from({ length: nChannels }, (_, i) => ({
        label: isMultiField
          ? allFields[i]
          : (channelLabels?.[i] ?? (nChannels === 1 ? config.field : `ch${i}`)),
        stroke: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
        width: 1.5,
      })),
    ]

    const opts: uPlot.Options = {
      width:  containerRef.current.clientWidth,
      height: 160,
      series,
      scales: {
        x: {
          // Always show exactly windowSecs of data anchored to the latest sample.
          range: (_u, _min, dataMax) => {
            const winS = windowSecsRef.current
            return [dataMax - winS, dataMax]
          },
        },
      },
      axes: [
        { label: hints.x_label ?? 'Time (s)', stroke: '#a6adc8', ticks: { stroke: '#313244' } },
        { label: hints.y_label ?? config.field, stroke: '#a6adc8', ticks: { stroke: '#313244' } },
      ],
      cursor: { show: false },
      legend: { show: nChannels <= 8 },
    }

    const emptyData: uPlot.AlignedData = [
      new Float64Array(0),
      ...Array.from({ length: nChannels }, () => new Float64Array(0)),
    ]

    plotRef.current = new uPlot(opts, emptyData, containerRef.current)
    bufRef.current  = { ts: [], channels: Array.from({ length: nChannels }, () => []) }
    pendingRef.current = new Map()

    return () => {
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [nChannels, config.field, isMultiField])  // eslint-disable-line react-hooks/exhaustive-deps

  // Register data handlers directly — bypasses React state so NO batches are dropped.
  // Each incoming batch is pushed straight into bufRef and uPlot is updated immediately.
  useEffect(() => {
    function flushBuffer() {
      const plot = plotRef.current
      const buf  = bufRef.current
      if (!plot || buf.ts.length === 0) return

      // Trim to MAX_BUFFER_SECS
      const now    = buf.ts[buf.ts.length - 1]
      const cutoff = now - MAX_BUFFER_SECS
      let trimIdx  = 0
      while (trimIdx < buf.ts.length && buf.ts[trimIdx] < cutoff) trimIdx++
      if (trimIdx > 0) {
        buf.ts.splice(0, trimIdx)
        buf.channels.forEach(ch => ch.splice(0, trimIdx))
      }

      // Hard cap (rate-derived)
      if (buf.ts.length > maxPoints) {
        const excess = buf.ts.length - maxPoints
        buf.ts.splice(0, excess)
        buf.channels.forEach(ch => ch.splice(0, excess))
      }

      plot.setData([
        new Float64Array(buf.ts),
        ...buf.channels.map(ch => new Float64Array(ch)),
      ])
    }

    const unsubs = allFields.map((field) =>
      registerDataHandler(config.stream, field, (batch) => {
        const buf = bufRef.current

        if (!isMultiField) {
          // Single-field: append all channels directly
          for (let s = 0; s < batch.nSamples; s++) {
            buf.ts.push(batch.timestamps[s])
            for (let ch = 0; ch < nChannels && ch < batch.nChannels; ch++) {
              buf.channels[ch].push(Number(batch.data[ch * batch.nSamples + s]))
            }
          }
          flushBuffer()
        } else {
          // Multi-field (all 1-ch): buffer by timestamp to align frames from each field.
          // Fields in the same Redis stream entry share identical ms timestamps,
          // so entries flush immediately once all fields have arrived.
          const pending = pendingRef.current
          for (let s = 0; s < batch.nSamples; s++) {
            const ts = batch.timestamps[s]
            if (!pending.has(ts)) pending.set(ts, new Map())
            pending.get(ts)!.set(field, Number(batch.data[s]))
          }

          // Flush entries where every field has data
          const sorted = Array.from(pending.keys()).sort((a, b) => a - b)
          let flushed  = false
          for (const ts of sorted) {
            const entry = pending.get(ts)!
            if (allFields.every(f => entry.has(f))) {
              buf.ts.push(ts)
              allFields.forEach((f, idx) => buf.channels[idx].push(entry.get(f)!))
              pending.delete(ts)
              flushed = true
            }
          }

          // Evict stale pending entries to prevent unbounded growth
          if (sorted.length > 0) {
            const latest = sorted[sorted.length - 1]
            for (const ts of sorted) {
              if (pending.has(ts) && ts < latest - MAX_BUFFER_SECS) pending.delete(ts)
            }
          }

          if (flushed) flushBuffer()
        }
      })
    )

    return () => unsubs.forEach(u => u())
  }, [config.stream, config.field, config.extraFields, registerDataHandler, isMultiField, nChannels, maxPoints])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef} style={{ width: '100%', background: '#181825', borderRadius: 6 }} />
  )
}

const CHANNEL_COLORS = [
  '#89b4fa', '#a6e3a1', '#f38ba8', '#fab387',
  '#f9e2af', '#94e2d5', '#cba6f7', '#89dceb',
]
