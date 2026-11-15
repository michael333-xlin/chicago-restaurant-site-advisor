import { useCallback, useEffect, useRef, useState } from 'react'
import { paybackColor } from '../colors'
import { reducedMotion } from '../format'
import { useInView } from '../hooks'

type Props = { samples: number[]; closures?: number[]; horizon: number; height?: number; label?: string }

// A draw whose license ends (survival model) before it pays back is drawn in this colour instead of its payback colour.
const LAPSE = 'rgba(132,146,255,1)'
const easeInOutCubic = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
const easeOutCubic = (u: number) => 1 - Math.pow(1 - u, 3)

type Layout = {
  w: number; h: number; left: number; right: number; top: number; base: number
  binW: number; dot: number; cols: number; overX: number; overW: number; overCols: number
}

type Particle = {
  i: number; spawn: number; dur: number
  x0: number; y0: number; x1: number; y1: number
  color: string; px: number; py: number; landed: boolean
}

const OVER_BINS = 7
const SPAWN_SPAN = 3600

function makeLayout(w: number, h: number, horizon: number, counts: number[], overflow: number): Layout {
  const left = 18, right = 18, top = 64, bottom = 34
  const plotW = w - left - right
  const binW = plotW / (horizon + 1 + OVER_BINS)
  const base = h - bottom
  const plotH = base - top - 6
  let dot = Math.min(8, binW)
  for (; dot > 1.4; dot -= 0.1) {
    const cols = Math.max(1, Math.floor(binW / dot + 1e-6))
    const overCols = Math.max(1, Math.floor((binW * (OVER_BINS - 1)) / dot))
    const rows = Math.max(...counts.map((c) => Math.ceil(c / cols)), Math.ceil(overflow / overCols))
    if (rows * dot <= plotH) break
  }
  const cols = Math.max(1, Math.floor(binW / dot + 1e-6))
  const overCols = Math.max(1, Math.floor((binW * (OVER_BINS - 1)) / dot))
  return { w, h, left, right, top, base, binW, dot, cols, overX: left + binW * (horizon + 2), overW: binW * (OVER_BINS - 1), overCols }
}

function q(sorted: number[], p: number) {
  if (!sorted.length) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[i]
}

export default function MonteCarloDrop({ samples, closures, horizon, height = 320, label = 'Months from opening to payback' }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const counterRef = useRef<HTMLSpanElement>(null)
  const [inViewRef, inView] = useInView<HTMLDivElement>({ threshold: 0.35 })
  const [run, setRun] = useState(0)
  const [done, setDone] = useState(false)

  const lapsedFirst = (i: number) => {
    const s = samples[i], c = closures?.[i]
    return c != null && Number.isFinite(s) && s <= horizon && c < s
  }
  const n = samples.length
  const nNever = samples.filter((s) => !(Number.isFinite(s) && s <= horizon)).length
  const nLapsed = closures ? samples.reduce((a, _, i) => a + (lapsedFirst(i) ? 1 : 0), 0) : 0
  const share = (k: number) => `${Math.round((100 * k) / Math.max(1, n))}%`

  const replay = useCallback(() => {
    setDone(false)
    setRun((r) => r + 1)
  }, [])

  useEffect(() => {
    if (!inView) return
    const canvas = canvasRef.current, wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = wrap.clientWidth, h = height
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    const N = samples.length
    const counts = new Array(horizon + 1).fill(0)
    let overflow = 0
    for (const s of samples) {
      if (Number.isFinite(s) && s <= horizon) counts[Math.min(horizon, Math.floor(s))]++
      else overflow++
    }
    const L = makeLayout(w, h, horizon, counts, overflow)

    // Static layer for settled dots.
    const settled = document.createElement('canvas')
    settled.width = canvas.width
    settled.height = canvas.height
    const sctx = settled.getContext('2d')!
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const slots = new Array(horizon + 1).fill(0)
    let overSlots = 0
    const nozzleX = L.left + (L.binW * (horizon + 1)) * 0.42
    const particles: Particle[] = samples.map((s, i) => {
      const finite = Number.isFinite(s) && s <= horizon
      let x1: number, y1: number
      if (finite) {
        const b = Math.min(horizon, Math.floor(s))
        const k = slots[b]++
        x1 = L.left + b * L.binW + ((k % L.cols) + 0.5) * (L.binW / L.cols)
        y1 = L.base - (Math.floor(k / L.cols) + 0.5) * L.dot
      } else {
        const k = overSlots++
        x1 = L.overX + ((k % L.overCols) + 0.5) * (L.overW / L.overCols)
        y1 = L.base - (Math.floor(k / L.overCols) + 0.5) * L.dot
      }
      const spawn = SPAWN_SPAN * Math.pow(i / N, 0.62)
      return {
        i, spawn, dur: 700 + ((i * 7919) % 300), x0: nozzleX + (((i * 104729) % 41) - 20), y0: 8,
        x1, y1, color: lapsedFirst(i) ? LAPSE : paybackColor(finite ? s : Infinity), px: nozzleX, py: 8, landed: false,
      }
    })

    const landedVals: number[] = []
    const flashes: { x: number; y: number; t: number; color: string }[] = []
    const lines = { p10: NaN, p50: NaN, p90: NaN }
    const r = Math.max(0.9, L.dot * 0.42)

    const drawDot = (c: CanvasRenderingContext2D, x: number, y: number, color: string) => {
      c.fillStyle = color
      c.beginPath()
      c.arc(x, y, r, 0, Math.PI * 2)
      c.fill()
    }
    // soft halo for falling dots: one translucent disc instead of canvas shadowBlur (which is slow per dot)
    const drawGlow = (x: number, y: number, color: string) => {
      ctx.fillStyle = color.replace(/,\s*1\)$/, ',0.22)')
      ctx.beginPath()
      ctx.arc(x, y, r * 2.4, 0, Math.PI * 2)
      ctx.fill()
    }

    const xOf = (m: number) => (Number.isFinite(m) && m <= horizon ? L.left + m * L.binW : L.overX + L.overW / 2)

    const drawFrame = (final: boolean) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // year bands + axis
      for (let y = 0; y < horizon / 12; y++) {
        ctx.fillStyle = y % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(255,255,255,0.035)'
        ctx.fillRect(L.left + y * 12 * L.binW, L.top - 8, 12 * L.binW, L.base - L.top + 8)
      }
      ctx.fillStyle = 'rgba(255,84,104,0.05)'
      ctx.fillRect(L.overX - L.binW * 0.5, L.top - 8, L.overW + L.binW, L.base - L.top + 8)
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(L.left, L.base + 0.5)
      ctx.lineTo(L.left + (horizon + 1) * L.binW, L.base + 0.5)
      ctx.moveTo(L.overX - L.binW * 0.5, L.base + 0.5)
      ctx.lineTo(L.overX + L.overW + L.binW * 0.5, L.base + 0.5)
      ctx.stroke()
      ctx.font = '500 10.5px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(244,239,232,0.45)'
      for (let m = 0; m <= horizon; m += 6) {
        const x = L.left + m * L.binW
        ctx.fillRect(x, L.base, 1, m % 12 === 0 ? 6 : 3)
        if (m % 12 === 0) ctx.fillText(m === 0 ? 'open' : `${m / 12} yr`, x, L.base + 19)
      }
      ctx.fillText(`> ${horizon / 12} yr`, L.overX + L.overW / 2, L.base + 19)

      ctx.drawImage(settled, 0, 0, w, h)

      // flashes
      for (const f of flashes) {
        const a = 1 - f.t
        ctx.strokeStyle = f.color.replace(/,\s*1\)$/, `,${(a * 0.8).toFixed(3)})`)
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(f.x, f.y, r + f.t * 7, 0, Math.PI * 2)
        ctx.stroke()
      }

      // quantile lines
      const marks: [keyof typeof lines, string, string][] = [
        ['p10', 'P10 · optimistic', 'rgba(124,240,197,0.95)'],
        ['p50', 'P50 · base', 'rgba(255,208,138,1)'],
        ['p90', 'P90 · conservative', 'rgba(255,120,90,0.95)'],
      ]
      for (const [k, name, color] of marks) {
        const v = lines[k]
        if (Number.isNaN(v)) continue
        const x = xOf(v)
        ctx.strokeStyle = color
        ctx.setLineDash([3, 4])
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.moveTo(x, L.top - 4)
        ctx.lineTo(x, L.base)
        ctx.stroke()
        ctx.setLineDash([])
        const text = `${name}  ${Number.isFinite(v) && v <= horizon ? `${Math.round(v)} mo` : `> ${horizon} mo`}`
        ctx.font = '600 11px Inter, sans-serif'
        const tw = ctx.measureText(text).width
        const ly = 14 + (k === 'p10' ? 0 : k === 'p50' ? 1 : 2) * 15
        const tx = Math.min(Math.max(x, L.left + tw / 2 + 4), w - L.right - tw / 2 - 4)
        ctx.fillStyle = 'rgba(8,10,14,0.85)'
        ctx.fillRect(tx - tw / 2 - 5, ly - 10, tw + 10, 14)
        ctx.fillStyle = color
        ctx.textAlign = 'center'
        ctx.fillText(text, tx, ly + 1)
      }

      if (final && overflow > 0) {
        ctx.font = '600 11px Inter, sans-serif'
        ctx.fillStyle = 'rgba(255,138,149,0.95)'
        ctx.textAlign = 'center'
        const y = L.base - Math.ceil(overflow / L.overCols) * L.dot - 10
        ctx.fillText(`${Math.round((100 * overflow) / N)}% never`, L.overX + L.overW / 2, Math.max(L.top + 4, y))
      }
    }

    const updateLines = (final: boolean, ease: number) => {
      if (landedVals.length < 40) return
      const s = [...landedVals].sort((a, b) => a - b)
      for (const [k, p] of [['p10', 0.1], ['p50', 0.5], ['p90', 0.9]] as const) {
        const target = q(s, p)
        const cur = lines[k]
        if (Number.isNaN(cur) || final || !Number.isFinite(target) || !Number.isFinite(cur)) lines[k] = target
        else lines[k] = cur + (target - cur) * ease
      }
    }

    if (reducedMotion()) {
      for (const pt of particles) {
        drawDot(sctx, pt.x1, pt.y1, pt.color)
        landedVals.push(samples[pt.i])
      }
      updateLines(true, 1)
      drawFrame(true)
      if (counterRef.current) counterRef.current.textContent = N.toLocaleString('en-US')
      setDone(true)
      return
    }

    let raf = 0
    const start = performance.now()
    let next = 0
    const active: Particle[] = []
    let last = start
    const tick = (now: number) => {
      const t = now - start
      const dt = Math.min(64, now - last)
      last = now
      while (next < N && particles[next].spawn <= t) active.push(particles[next++])
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      for (let j = active.length - 1; j >= 0; j--) {
        const pt = active[j]
        const u = Math.min(1, (t - pt.spawn) / pt.dur)
        if (u >= 1) {
          drawDot(sctx, pt.x1, pt.y1, pt.color)
          flashes.push({ x: pt.x1, y: pt.y1, t: 0, color: pt.color })
          landedVals.push(samples[pt.i])
          pt.landed = true
          active.splice(j, 1)
        }
      }
      for (const f of flashes) f.t += dt / 420
      for (let j = flashes.length - 1; j >= 0; j--) if (flashes[j].t >= 1) flashes.splice(j, 1)
      updateLines(false, 1 - Math.exp(-dt / 160))   // time-based easing: same speed at any frame rate
      const finished = next >= N && active.length === 0
      drawFrame(finished)
      // falling particles with trails
      for (const pt of active) {
        const u = Math.min(1, (t - pt.spawn) / pt.dur)
        // ease in and out on both axes: dots accelerate, then settle onto the pile instead of hitting it at full speed
        const x = pt.x0 + (pt.x1 - pt.x0) * easeOutCubic(u)
        const y = pt.y0 + (pt.y1 - pt.y0) * easeInOutCubic(u)
        // Trail along the direction of travel, capped so low frame rates don't draw long streaks.
        const dx = x - pt.px, dy = y - pt.py
        const len = Math.hypot(dx, dy) || 1
        const tl = Math.min(22, len * 3.5)
        const tx = x - (dx / len) * tl, ty = y - (dy / len) * tl
        const g = ctx.createLinearGradient(tx, ty, x, y)
        g.addColorStop(0, pt.color.replace(/,\s*1\)$/, ',0)'))
        g.addColorStop(1, pt.color)
        ctx.strokeStyle = g
        ctx.lineWidth = r * 1.4
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(tx, ty)
        ctx.lineTo(x, y)
        ctx.stroke()
        drawGlow(x, y, pt.color)
        drawDot(ctx, x, y, pt.color)
        pt.px = x
        pt.py = y
      }
      // nozzle glow
      if (!finished) {
        const ng = ctx.createRadialGradient(nozzleX, 6, 0, nozzleX, 6, 26)
        ng.addColorStop(0, 'rgba(255,208,138,0.55)')
        ng.addColorStop(1, 'rgba(255,208,138,0)')
        ctx.fillStyle = ng
        ctx.fillRect(nozzleX - 26, 0, 52, 32)
      }
      if (counterRef.current) counterRef.current.textContent = landedVals.length.toLocaleString('en-US')
      if (finished) {
        updateLines(true, 1)
        drawFrame(true)
        setDone(true)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lapsedFirst only reads samples / closures / horizon
  }, [inView, samples, closures, horizon, height, run])

  return (
    <div className="mc" ref={inViewRef}>
      <div className="mc-head">
        <div>
          <div className="eyebrow">Monte Carlo · each dot is one simulated future</div>
          <div className="mc-count">
            <span ref={counterRef}>0</span> / {samples.length.toLocaleString('en-US')} draws
          </div>
          {closures && (
            <div className="mc-legend">
              <span><i style={{ background: paybackColor(30) }} />pays back before the license ends {share(n - nNever - nLapsed)}</span>
              <span><i style={{ background: LAPSE }} />license ends first (survival model) {share(nLapsed)}</span>
              <span><i style={{ background: paybackColor(Infinity) }} />no payback in {horizon / 12} yrs {share(nNever)}</span>
            </div>
          )}
        </div>
        <button className="ghost-btn" onClick={replay} disabled={!done}>
          ↻ Replay
        </button>
      </div>
      <div ref={wrapRef} className="mc-canvas">
        <canvas ref={canvasRef} />
      </div>
      <div className="mc-foot muted">{label}</div>
    </div>
  )
}
