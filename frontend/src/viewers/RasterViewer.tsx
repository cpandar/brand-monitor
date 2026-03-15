import { useEffect, useRef } from 'react'
import { DataBatch, ViewerConfig } from '../types'

const ROW_HEIGHT = 2    // pixels per channel row

interface RasterEvent {
  ts: number  // seconds
  ch: number  // channel index
}

interface Props {
  config: ViewerConfig
  registerDataHandler: (stream: string, field: string, handler: (batch: DataBatch) => void) => () => void
  windowSecs: number
}

export function RasterViewer({ config, registerDataHandler, windowSecs }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const eventsRef    = useRef<RasterEvent[]>([])
  const animFrameRef = useRef<number>(0)
  const windowSecsRef = useRef(windowSecs)
  windowSecsRef.current = windowSecs

  const nChannels   = config.fieldInfo.n_channels
  const canvasHeight = Math.max(80, nChannels * ROW_HEIGHT)

  // Register data handler directly — no React state intermediary, so no batches are dropped
  useEffect(() => {
    return registerDataHandler(config.stream, config.field, (batch) => {
      const events  = eventsRef.current
      const winS    = windowSecsRef.current

      for (let s = 0; s < batch.nSamples; s++) {
        const ts = batch.timestamps[s]
        for (let ch = 0; ch < batch.nChannels; ch++) {
          if (batch.data[ch * batch.nSamples + s] !== 0) {
            events.push({ ts, ch })
          }
        }
      }

      // Trim events older than the current window
      const now    = batch.timestamps[batch.timestamps.length - 1]
      const cutoff = now - winS
      let i = 0
      while (i < events.length && events[i].ts < cutoff) i++
      if (i > 0) events.splice(0, i)
    })
  }, [config.stream, config.field, registerDataHandler])

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    function render() {
      const events  = eventsRef.current
      const windowS = windowSecsRef.current
      const W = canvas!.width
      const H = canvas!.height

      ctx.fillStyle = '#181825'
      ctx.fillRect(0, 0, W, H)

      if (events.length === 0) {
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const now    = events[events.length - 1].ts
      const tStart = now - windowS
      const tRange = windowS

      ctx.fillStyle = '#89b4fa'
      for (const ev of events) {
        const x = ((ev.ts - tStart) / tRange) * W
        const y = (ev.ch / nChannels) * H
        ctx.fillRect(x, y, 2, Math.max(1, ROW_HEIGHT))
      }

      // Channel axis labels (every 32 channels)
      ctx.fillStyle = '#6c7086'
      ctx.font = '9px monospace'
      for (let ch = 0; ch < nChannels; ch += 32) {
        const y = (ch / nChannels) * H
        ctx.fillText(`${ch}`, 2, y + 9)
      }

      animFrameRef.current = requestAnimationFrame(render)
    }

    animFrameRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [nChannels])

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={canvasHeight}
      style={{ width: '100%', height: canvasHeight, display: 'block', borderRadius: 6 }}
    />
  )
}
