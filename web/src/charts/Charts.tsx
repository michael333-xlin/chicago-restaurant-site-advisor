import { useState } from 'react'
import { gapColor, gapSpan, paybackColor, RANK_COLORS } from '../colors'
import { CUISINE_SHORT, CUISINES, STOREFRONT_LABEL, type Cuisine, type Plan, type PlanDetail, type PnL, type Report, type StartupBreakdown } from '../types'
import { monthsNum, pct, usd } from '../format'
import { useInView, useTween } from '../hooks'

const rgb = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

// ---------- cumulative cash fan ----------
export function FanChart({ fan, horizon, payback }: { fan: PlanDetail['fan']; horizon: number; payback: PlanDetail['payback'] }) {
  const [ref, inView] = useInView<SVGSVGElement>({ threshold: 0.3 })
  const W = 680, H = 260, l = 54, r = 14, t = 16, b = 30
  const lo = Math.min(...fan.map((f) => f.p10)), hi = Math.max(0, ...fan.map((f) => f.p90))
  const pad = (hi - lo) * 0.06
  const y0 = lo - pad, y1 = hi + pad
  const x = (m: number) => l + (m / horizon) * (W - l - r)
  const y = (v: number) => t + (1 - (v - y0) / (y1 - y0)) * (H - t - b)
  const line = (k: 'p10' | 'p50' | 'p90') => fan.map((f, m) => `${m ? 'L' : 'M'}${x(m).toFixed(1)},${y(f[k]).toFixed(1)}`).join('')
  const band = `${line('p90')}${fan.map((_, m) => `L${x(fan.length - 1 - m).toFixed(1)},${y(fan[fan.length - 1 - m].p10).toFixed(1)}`).join('')}Z`
  const ticks = Array.from({ length: Math.floor(horizon / 12) + 1 }, (_, i) => i * 12)
  const yTicks = 5
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className={`chart fan ${inView ? 'in' : ''}`}>
      <defs>
        <linearGradient id="fanband" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffb248" stopOpacity="0.34" />
          <stop offset="1" stopColor="#6f7dff" stopOpacity="0.16" />
        </linearGradient>
        <clipPath id="fanclip">
          <rect className="clip-grow" x={l} y={0} width={W - l - r} height={H} />
        </clipPath>
      </defs>
      {Array.from({ length: yTicks + 1 }, (_, i) => y0 + ((y1 - y0) * i) / yTicks).map((v) => (
        <g key={v}>
          <line x1={l} x2={W - r} y1={y(v)} y2={y(v)} className="grid" />
          <text x={l - 8} y={y(v) + 3} textAnchor="end" className="tick">{usd(v)}</text>
        </g>
      ))}
      {ticks.map((m) => (
        <text key={m} x={x(m)} y={H - 10} textAnchor="middle" className="tick">{m === 0 ? 'open' : `${m / 12} yr`}</text>
      ))}
      <g clipPath="url(#fanclip)">
        <path d={band} fill="url(#fanband)" />
        <path d={line('p10')} className="fan-edge" />
        <path d={line('p90')} className="fan-edge" />
        <path d={line('p50')} className="fan-mid" />
      </g>
      <line x1={l} x2={W - r} y1={y(0)} y2={y(0)} className="zero" />
      <text x={W - r} y={y(0) - 6} textAnchor="end" className="zero-label">Startup cost recovered</text>
      {Number.isFinite(payback.p50) && payback.p50 <= horizon && (
        <g className="fan-marker">
          <circle cx={x(payback.p50)} cy={y(0)} r={5} />
          <text x={x(payback.p50)} y={y(0) + 18} textAnchor="middle">base {Math.round(payback.p50)} mo</text>
        </g>
      )}
    </svg>
  )
}

// ---------- tornado ----------
export function Tornado({ items, base, horizon }: { items: PlanDetail['sensitivity']; base: number; horizon: number }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.3 })
  const cap = (v: number) => (Number.isFinite(v) ? Math.min(v, horizon + 6) : horizon + 6)
  const b = cap(base)
  const rows = items
    .map((it) => ({ ...it, dl: cap(it.low) - b, dh: cap(it.high) - b }))
    .sort((p, q) => Math.max(Math.abs(q.dl), Math.abs(q.dh)) - Math.max(Math.abs(p.dl), Math.abs(p.dh)))
  const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.dl), Math.abs(r.dh)]))
  const fmt = (d: number) => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(1)} mo`
  return (
    <div ref={ref} className={`tornado ${inView ? 'in' : ''}`}>
      <div className="tornado-head">
        <span>Payback gets faster ←</span>
        <span className="muted">central case {monthsNum(base)} mo</span>
        <span>→ slower</span>
      </div>
      {rows.map((r, i) => {
        const sides = [{ d: r.dl, tag: '−10%' }, { d: r.dh, tag: '+10%' }]
        const left = sides.filter((x) => x.d < 0)
        const right = sides.filter((x) => x.d >= 0)
        const txt = (xs: typeof sides) => xs.map((x) => `${x.tag} ${fmt(x.d)}`).join(' · ')
        return (
          <div className="t-row" key={r.driver} style={{ transitionDelay: `${i * 90}ms` }}>
            <div className="t-label">{r.driver}</div>
            <div className="t-val l">{txt(left)}</div>
            <div className="t-track">
              <div className="t-axis" />
              {sides.map(({ d, tag }) => (
                <div
                  key={tag}
                  className={`t-bar ${d < 0 ? 'good' : 'bad'}`}
                  style={{ width: `${(Math.abs(d) / max) * 50}%`, left: d < 0 ? `${50 - (Math.abs(d) / max) * 50}%` : '50%' }}
                />
              ))}
            </div>
            <div className="t-val r">{txt(right)}</div>
          </div>
        )
      })}
    </div>
  )
}

// ---------- monthly P&L waterfall ----------
export function Waterfall({ pnl }: { pnl: PnL }) {
  const [ref, inView] = useInView<SVGSVGElement>({ threshold: 0.3 })
  const W = 680, H = 250, l = 50, r = 10, t = 20, b = 40
  const steps = [
    { label: 'Revenue', v: pnl.revenue, kind: 'rev' },
    { label: 'Food & bev', v: -pnl.food, kind: 'cost' },
    { label: 'Labor', v: -pnl.labor, kind: 'cost' },
    { label: 'Rent + NNN', v: -pnl.rent, kind: 'cost' },
    { label: 'Other opex', v: -pnl.other, kind: 'cost' },
    { label: 'Net cash flow', v: pnl.net, kind: pnl.net >= 0 ? 'net' : 'loss' },
  ]
  const max = pnl.revenue * 1.08
  const min = Math.min(0, pnl.net * 1.2)
  const y = (v: number) => t + (1 - (v - min) / (max - min)) * (H - t - b)
  const bw = (W - l - r) / steps.length
  let run = 0
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className={`chart waterfall ${inView ? 'in' : ''}`}>
      <line x1={l} x2={W - r} y1={y(0)} y2={y(0)} className="zero" />
      {steps.map((s, i) => {
        let top: number, bot: number
        if (s.kind === 'rev') { top = s.v; bot = 0; run = s.v }
        else if (s.kind === 'cost') { top = run; bot = run + s.v; run = bot }
        else { top = Math.max(0, s.v); bot = Math.min(0, s.v) }
        const x = l + i * bw + bw * 0.18
        const hgt = Math.max(1, y(bot) - y(top))
        return (
          <g key={s.label} className={`wf-step ${s.kind}`} style={{ transitionDelay: `${i * 120}ms` }}>
            <rect x={x} y={y(top)} width={bw * 0.64} height={hgt} rx={5} />
            <text x={x + bw * 0.32} y={y(top) - 7} textAnchor="middle" className="wf-val">{s.kind === 'cost' ? `−${usd(-s.v)}` : usd(s.v)}</text>
            <text x={x + bw * 0.32} y={H - 22} textAnchor="middle" className="tick">{s.label}</text>
            <text x={x + bw * 0.32} y={H - 8} textAnchor="middle" className="tick faint">{pct(Math.abs(s.v) / pnl.revenue)}</text>
            {i < steps.length - 1 && s.kind !== 'net' && (
              <line x1={x + bw * 0.64} x2={x + bw} y1={y(s.kind === 'rev' ? s.v : bot)} y2={y(s.kind === 'rev' ? s.v : bot)} className="wf-link" />
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ---------- startup stacked bar ----------
const STARTUP_PARTS: { key: keyof StartupBreakdown; label: string; color: string }[] = [
  { key: 'buildout', label: 'Build-out', color: '#ffb248' },
  { key: 'equipment', label: 'Equipment', color: '#ff8a4c' },
  { key: 'keyMoney', label: 'Key money', color: '#ff5c38' },
  { key: 'deposit', label: 'Deposit', color: '#c58bff' },
  { key: 'licenses', label: 'Licenses & permits', color: '#8a96ff' },
  { key: 'preOpening', label: 'Pre-opening (incl. rent)', color: '#5fc8ff' },
  { key: 'reserve', label: 'Working-capital reserve', color: '#7cf0c5' },
]

export function StartupBar({ plan, budgetMin, budgetMax }: { plan: Plan; budgetMin: number; budgetMax: number }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.3 })
  const bd = plan.startup.breakdown
  const scale = Math.max(budgetMax, plan.startup.p90) * 1.08
  const parts = STARTUP_PARTS.filter((p) => bd[p.key] > 0)
  return (
    <div ref={ref} className={`startup ${inView ? 'in' : ''}`}>
      <div className="sb-track">
        {parts.map((p, i) => (
          <div key={p.key} className="sb-seg" style={{ width: `${(bd[p.key] / scale) * 100}%`, background: p.color, transitionDelay: `${i * 90}ms` }} title={`${p.label}: ${usd(bd[p.key])}`} />
        ))}
        <div className="sb-budget" style={{ left: `${(budgetMin / scale) * 100}%`, right: `${100 - (budgetMax / scale) * 100}%` }}>
          <span>budget {usd(budgetMin)}–{usd(budgetMax)}</span>
        </div>
        <div className="sb-range" style={{ left: `${(plan.startup.p10 / scale) * 100}%`, width: `${((plan.startup.p90 - plan.startup.p10) / scale) * 100}%` }} />
      </div>
      <div className="sb-legend">
        {parts.map((p) => (
          <div key={p.key}>
            <i style={{ background: p.color }} />
            <span>{p.label}</span>
            <b>{usd(bd[p.key])}</b>
          </div>
        ))}
      </div>
      <div className="sb-note muted">
        Bar = central estimate {usd(bd.total)}. Whisker = P10–P90 across 1,000 draws ({usd(plan.startup.p10)}–{usd(plan.startup.p90)}).
      </div>
    </div>
  )
}

// ---------- gauge ----------
export function Gauge({ value, label, sub }: { value: number; label: string; sub?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.4 })
  const v = useTween(value, inView, 1300)
  const R = 70, C = Math.PI * R
  const color = value < 35 ? '#7cf0c5' : value < 60 ? '#ffd08a' : value < 80 ? '#ff8a4c' : '#ff5468'
  return (
    <div ref={ref} className="gauge">
      <svg viewBox="0 0 180 104">
        <path d="M20,94 A70,70 0 0 1 160,94" className="g-track" />
        <path d="M20,94 A70,70 0 0 1 160,94" className="g-fill" style={{ stroke: color, strokeDasharray: C, strokeDashoffset: C * (1 - v / 100) }} />
        <text x="90" y="80" textAnchor="middle" className="g-num">{Math.round(v)}</text>
        <text x="90" y="98" textAnchor="middle" className="g-sub">/ 100</text>
      </svg>
      <div className="g-label" style={{ color }}>{label}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  )
}

// ---------- payback vs risk scatter ----------
export function Scatter({ report, onPick }: { report: Report; onPick: (i: number) => void }) {
  const [ref, inView] = useInView<SVGSVGElement>({ threshold: 0.25 })
  const [hover, setHover] = useState<Plan | null>(null)
  const W = 680, H = 340, l = 52, r = 16, t = 18, b = 40
  const H0 = report.horizon
  const cap = (v: number) => (Number.isFinite(v) ? Math.min(v, H0 + 4) : H0 + 4)
  // axes fitted to the plans actually simulated (6-month steps, at least 18 months wide), not a fixed 0-72
  const xs = report.plans.map((p) => cap(p.payback.p50))
  let x0 = Math.max(0, Math.floor((Math.min(...xs) - 3) / 6) * 6)
  let x1 = Math.min(H0 + 6, Math.ceil((Math.max(...xs) + 3) / 6) * 6)
  if (x1 - x0 < 18) {
    const mid = (x0 + x1) / 2
    x0 = Math.max(0, Math.floor((mid - 9) / 6) * 6)
    x1 = x0 + 18
  }
  const x = (m: number) => l + ((cap(m) - x0) / (x1 - x0)) * (W - l - r)
  const step = x1 - x0 > 48 ? 12 : 6
  const xTicks = Array.from({ length: Math.floor((x1 - x0) / step) + 1 }, (_, i) => x0 + i * step).filter((m) => m <= H0)
  const NICE = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1]
  const rawMax = Math.max(...report.plans.map((p) => p.noPaybackProb)) * 1.15
  const maxY = NICE.find((v) => v >= rawMax) ?? 1
  const y = (v: number) => t + (1 - v / maxY) * (H - t - b)
  const topIdx = new Map(report.top.map((p, i) => [p.id, i]))
  const plans = [...report.plans].sort((p, q) => (topIdx.has(p.id) ? 1 : 0) - (topIdx.has(q.id) ? 1 : 0))
  const sweetX = Math.min(30, x1)
  const nOver = report.plans.filter((p) => !p.feasible).length
  return (
    <div className="scatter-wrap">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className={`chart scatter ${inView ? 'in' : ''}`}>
        {x0 < 30 && (
          <>
            <rect x={l} y={y(Math.min(maxY, 0.1))} width={x(sweetX) - l} height={y(0) - y(Math.min(maxY, 0.1))} className="sweet" />
            <text x={l + 8} y={y(0) - 8} className="sweet-label">Fast &amp; safe (&lt;30 mo, &lt;10% no payback)</text>
          </>
        )}
        {xTicks.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={t} y2={H - b} className="grid" />
            <text x={x(m)} y={H - b + 16} textAnchor="middle" className="tick">{m >= H0 ? `${H0}+` : m}</text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY).map((v) => (
          <g key={v}>
            <line x1={l} x2={W - r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={l - 8} y={y(v) + 3} textAnchor="end" className="tick">{pct(v)}</text>
          </g>
        ))}
        <text x={(l + W - r) / 2} y={H - 6} textAnchor="middle" className="axis-label">Base-case (P50) payback, months</text>
        <text x={14} y={(t + H - b) / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 14 ${(t + H - b) / 2})`}>Chance of no payback within 5 yrs</text>
        {plans.map((p, i) => {
          const rank = topIdx.get(p.id)
          const rad = 3.5 + (p.sqft / 1000) * 1.8
          const base = paybackColor(p.payback.p50, 1)
          const fill = rank != null ? rgb(RANK_COLORS[rank]) : p.feasible ? paybackColor(p.payback.p50, 0.9) : paybackColor(p.payback.p50, 0.16)
          const stroke = rank != null ? '#fff' : p.feasible ? 'rgba(8,10,14,0.85)' : base
          return (
            <g
              key={p.id}
              className={`pt ${rank != null ? 'top' : ''} ${p.feasible ? '' : 'infeasible'}`}
              style={{ transitionDelay: `${Math.min(i * 12, 900)}ms` }}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onClick={() => rank != null && onPick(rank)}
            >
              <circle cx={x(p.payback.p50)} cy={y(p.noPaybackProb)} r={rank != null ? rad + 3 : rad} fill={fill} stroke={stroke} strokeWidth={p.feasible ? 1 : 1.6} />
              {rank != null && (
                <text x={x(p.payback.p50)} y={y(p.noPaybackProb) - rad - 8} textAnchor="middle" className="pt-rank">#{rank + 1}</text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="scatter-tip">
        {hover ? (
          <>
            <b>{hover.block.street.label}</b> · {hover.sqft.toLocaleString()} sq ft · {STOREFRONT_LABEL[hover.storefront]}
            <br />
            P50 payback {monthsNum(hover.payback.p50)} mo · no payback in 5 yrs {pct(hover.noPaybackProb)} · startup {usd(hover.startup.p50)} · {hover.feasible ? 'within budget' : 'over budget'}
          </>
        ) : (
          <span className="muted">
            {report.plans.length} simulated plans ({nOver} over budget) · colour = payback speed · filled = within budget, ring = over budget · dot size = floor area. Axes fitted to
            the plans shown. Hover a dot for details.
          </span>
        )}
      </div>
    </div>
  )
}

// ---------- block × cuisine gap matrix ----------
export function GapMatrix({ report }: { report: Report }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.25 })
  const mine = report.inputs.cuisine
  const rows = [...report.matrix.map((m) => ({ label: m.label, sub: m.block.street.grid, gaps: m.gaps })), { label: `ZIP ${report.zip.zip} average`, sub: 'all commercial blocks', gaps: report.zipGaps }]
  const best = (g: Record<Cuisine, number>) => CUISINES.reduce((a, c) => (g[c] > g[a] ? c : a), CUISINES[0])
  const span = gapSpan(rows.flatMap((r) => CUISINES.map((c) => r.gaps[c])))
  return (
    <div ref={ref} className={`matrix ${inView ? 'in' : ''}`}>
      <div className="mx-row head">
        <div />
        {CUISINES.map((c) => (
          <div key={c} className={c === mine ? 'mine' : ''}>{CUISINE_SHORT[c]}</div>
        ))}
      </div>
      {rows.map((r, i) => (
        <div className={`mx-row ${i === rows.length - 1 ? 'total' : ''}`} key={r.label + i}>
          <div className="mx-label">
            <b>{i < report.top.length ? `#${i + 1} ` : ''}{r.label}</b>
            <span>{r.sub}</span>
          </div>
          {CUISINES.map((c, j) => {
            const g = r.gaps[c]
            const col = gapColor(g, 255, span)
            return (
              <div
                key={c}
                className={`mx-cell ${c === mine ? 'mine' : ''} ${best(r.gaps) === c ? 'best' : ''}`}
                style={{ background: rgb(col, 0.85), transitionDelay: `${(i * 4 + j) * 40}ms` }}
              >
                {g >= 0 ? '+' : ''}{g.toFixed(1)}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
