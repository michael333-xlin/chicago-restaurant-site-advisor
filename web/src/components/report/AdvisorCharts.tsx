// "At a glance" charts for the plain-English report. Same numbers the report text uses (the model results).
// Built to the dataviz rules: sites are rows named by label + rank badge (single series -> one hue, no legend);
// the monthly split is a horizontal stacked bar with five validated categorical slots, a legend, 2px surface gaps,
// a rounded data-end and one direct label (net cash flow). Every mark has a hover/focus tooltip and the values
// are also in a table view.
import { useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { RANK_COLORS } from '../../colors'
import { monthsNum, pct, usd, usdFull } from '../../format'
import type { PlanDetail, Report } from '../../types'

const ACCENT = '#ffd08a' // single-series marks (theme cream), >= 3:1 on the panel surface
const SURFACE = '#0d1017' // --panel-solid: ring and gap color
// Reference dark categorical slots 1-5, validated on #0d1017: CVD dE 8.4, normal-vision dE 19.3, all >= 3:1.
const PARTS = [
  { key: 'food', label: 'Food & drink', color: '#3987e5' },
  { key: 'labor', label: 'Labor', color: '#d95926' },
  { key: 'rent', label: 'Rent incl. NNN', color: '#199e70' },
  { key: 'other', label: 'Other costs', color: '#c98500' },
  { key: 'net', label: 'Net cash flow', color: '#d55181' },
] as const

const W = 640, LABEL = 168, RIGHT = 70, ROW = 46, TOP = 30, AXIS = 30

type Tip = { x: number; y: number; value: string; label: string } | null

function useTip() {
  const [tip, setTip] = useState<Tip>(null)
  const at = (e: MouseEvent<SVGElement> | FocusEvent<SVGElement>, value: string, label: string) => {
    const wrap = (e.currentTarget as Element).closest('.adv-chart') as HTMLElement | null
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    if ('clientX' in e) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, value, label })
    else {
      const b = (e.currentTarget as Element).getBoundingClientRect()
      setTip({ x: b.left - r.left + b.width / 2, y: b.top - r.top, value, label })
    }
  }
  return { tip, at, hide: () => setTip(null) }
}

function TipBox({ tip }: { tip: Tip }) {
  if (!tip) return null
  return (
    <div className="adv-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <b>{tip.value}</b>
      <span>{tip.label}</span>
    </div>
  )
}

function niceTicks(lo: number, hi: number, n = 5) {
  const raw = (hi - lo) / n
  const mag = 10 ** Math.floor(Math.log10(raw || 1))
  const f = raw / mag
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = start; v <= end + step * 1e-6; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { lo: start, hi: end, ticks }
}

function SiteLabel({ t, i, y }: { t: PlanDetail; i: number; y: number }) {
  const c = RANK_COLORS[i] ?? RANK_COLORS[RANK_COLORS.length - 1]
  const name = t.block.street.label.length > 19 ? `${t.block.street.label.slice(0, 18)}…` : t.block.street.label
  return (
    <g>
      <rect x={0} y={y - 10} width={22} height={20} rx={6} fill={`rgb(${c.join(',')})`} />
      <text x={11} y={y + 4} textAnchor="middle" className="adv-badge-text">#{i + 1}</text>
      <text x={30} y={y + 4} className="adv-row-label">{name}</text>
    </g>
  )
}

function Frame({ title, note, legend, children, tip }: { title: string; note?: string; legend?: ReactNode; children: ReactNode; tip: Tip }) {
  return (
    <figure className="adv-chart">
      <h5>{title}</h5>
      {legend}
      <div className="adv-chart-body">
        {children}
        <TipBox tip={tip} />
      </div>
      {note && <figcaption>{note}</figcaption>}
    </figure>
  )
}

/** Startup cost per site: good-to-cautious range, typical dot, the budget as a band. */
export function StartupChart({ report, note }: { report: Report; note?: string }) {
  const { tip, at, hide } = useTip()
  const sites = report.top
  const { budgetMin, budgetMax } = report.inputs
  const lo0 = Math.min(budgetMin, ...sites.map((t) => t.startup.p10)), hi0 = Math.max(budgetMax, ...sites.map((t) => t.startup.p90))
  const { lo, hi, ticks } = niceTicks(lo0 - (hi0 - lo0) * 0.04, hi0 + (hi0 - lo0) * 0.04)
  const x = (v: number) => LABEL + ((v - lo) / (hi - lo)) * (W - LABEL - RIGHT)
  const H = TOP + sites.length * ROW + AXIS
  const yAxis = TOP + sites.length * ROW
  return (
    <Frame title="What it costs to open" note={note} tip={tip}>
      <svg viewBox={`0 0 ${W} ${H}`} className="adv-svg" onMouseLeave={hide}>
        <rect x={x(budgetMin)} y={TOP - 6} width={Math.max(2, x(budgetMax) - x(budgetMin))} height={yAxis - TOP + 6} className="adv-band" />
        <text x={(x(budgetMin) + x(budgetMax)) / 2} y={TOP - 12} textAnchor="middle" className="adv-muted-text">Your budget {usd(budgetMin)}–{usd(budgetMax)}</text>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={TOP - 6} y2={yAxis} className="adv-grid" />
            <text x={x(v)} y={yAxis + 18} textAnchor="middle" className="adv-tick">{usd(v)}</text>
          </g>
        ))}
        {sites.map((t, i) => {
          const y = TOP + i * ROW + ROW / 2
          const label = `${t.block.street.label}: good case ${usd(t.startup.p10)}, typical ${usd(t.startup.p50)}, cautious ${usd(t.startup.p90)} · ${t.feasible ? 'within budget' : 'over budget'}`
          return (
            <g key={t.id} tabIndex={0} onMouseMove={(e) => at(e, usd(t.startup.p50), label)} onFocus={(e) => at(e, usd(t.startup.p50), label)} onBlur={hide}>
              <rect x={0} y={y - ROW / 2} width={W} height={ROW} fill="transparent" />
              <SiteLabel t={t} i={i} y={y} />
              <line x1={x(t.startup.p10)} x2={x(t.startup.p90)} y1={y} y2={y} className="adv-range" stroke={ACCENT} />
              <circle cx={x(t.startup.p50)} cy={y} r={5.5} fill={ACCENT} stroke={SURFACE} strokeWidth={2} />
              <text x={x(t.startup.p50)} y={y - 11} textAnchor="middle" className="adv-value-text">{usd(t.startup.p50)}</text>
            </g>
          )
        })}
      </svg>
      <p className="adv-key"><i className="dot" /> typical case · line = good case to cautious case (1,000 simulated futures) · shaded = your budget</p>
    </Frame>
  )
}

/** Payback months per site: good-to-cautious range, typical dot, a 5-year reference line. */
export function PaybackChart({ report, note }: { report: Report; note?: string }) {
  const { tip, at, hide } = useTip()
  const sites = report.top
  const hz = report.horizon
  const cap = (v: number) => (Number.isFinite(v) ? Math.min(v, hz) : hz)
  const beyond = sites.some((t) => !Number.isFinite(t.payback.p90) || t.payback.p90 > hz)
  const hiData = Math.max(...sites.map((t) => cap(t.payback.p90)))
  const hi = beyond ? hz : Math.min(hz, Math.ceil((hiData + 6) / 12) * 12)
  const step = hi > 36 ? 12 : 6
  const ticks = Array.from({ length: Math.floor(hi / step) + 1 }, (_, k) => k * step)
  const x = (m: number) => LABEL + (cap(m) / hi) * (W - LABEL - RIGHT)
  const H = TOP + sites.length * ROW + AXIS
  const yAxis = TOP + sites.length * ROW
  const fmt = (v: number) => (Number.isFinite(v) && v <= hz ? `${monthsNum(v)} mo` : `${hz}+ mo`)
  return (
    <Frame title="How long until it pays back" note={note} tip={tip}>
      <svg viewBox={`0 0 ${W} ${H}`} className="adv-svg" onMouseLeave={hide}>
        {ticks.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={TOP - 6} y2={yAxis} className="adv-grid" />
            <text x={x(m)} y={yAxis + 18} textAnchor="middle" className="adv-tick">{m === 0 ? 'open' : `${m} mo`}</text>
          </g>
        ))}
        {hi >= 60 && (
          <g>
            <line x1={x(60)} x2={x(60)} y1={TOP - 10} y2={yAxis} className="adv-ref" />
            <text x={x(60)} y={TOP - 14} textAnchor="middle" className="adv-muted-text">5 years</text>
          </g>
        )}
        {sites.map((t, i) => {
          const y = TOP + i * ROW + ROW / 2
          const label = `${t.block.street.label}: good case ${fmt(t.payback.p10)}, typical ${fmt(t.payback.p50)}, cautious ${fmt(t.payback.p90)} · ${pct(t.noPaybackProb)} chance of no payback in 5 years`
          const open = !Number.isFinite(t.payback.p90) || t.payback.p90 > hz
          return (
            <g key={t.id} tabIndex={0} onMouseMove={(e) => at(e, fmt(t.payback.p50), label)} onFocus={(e) => at(e, fmt(t.payback.p50), label)} onBlur={hide}>
              <rect x={0} y={y - ROW / 2} width={W} height={ROW} fill="transparent" />
              <SiteLabel t={t} i={i} y={y} />
              <line x1={x(t.payback.p10)} x2={x(t.payback.p90)} y1={y} y2={y} className="adv-range" stroke={ACCENT} />
              {open && <path d={`M${x(hz) - 1},${y - 5} L${x(hz) + 6},${y} L${x(hz) - 1},${y + 5}`} fill={ACCENT} opacity={0.6} />}
              <circle cx={x(t.payback.p50)} cy={y} r={5.5} fill={ACCENT} stroke={SURFACE} strokeWidth={2} />
              <text x={x(t.payback.p50)} y={y - 11} textAnchor="middle" className="adv-value-text">{fmt(t.payback.p50)}</text>
            </g>
          )
        })}
      </svg>
      <p className="adv-key"><i className="dot" /> typical case · line = good case to cautious case{beyond ? ` · arrow = some futures take longer than ${hz} months` : ''}</p>
    </Frame>
  )
}

function roundedEnd(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`
}

/** Monthly sales at steady state split into costs and net cash flow, one stacked bar per site. */
export function MonthlyChart({ report, note }: { report: Report; note?: string }) {
  const { tip, at, hide } = useTip()
  const sites = report.top
  const parts = (t: PlanDetail) => ({ food: t.pnl.food, labor: t.pnl.labor, rent: t.pnl.rent, other: t.pnl.other, net: t.pnl.net })
  const maxV = Math.max(...sites.map((t) => Math.max(t.pnl.revenue, t.pnl.food + t.pnl.labor + t.pnl.rent + t.pnl.other)))
  const { hi, ticks } = niceTicks(0, maxV * 1.02, 4)
  const x = (v: number) => LABEL + (v / hi) * (W - LABEL - RIGHT - 30)
  const H = TOP + sites.length * ROW + AXIS
  const yAxis = TOP + sites.length * ROW
  const BAR = 18, GAP = 2
  const legend = (
    <div className="adv-legend">
      {PARTS.map((p) => (
        <span key={p.key}><i style={{ background: p.color }} />{p.label}</span>
      ))}
    </div>
  )
  return (
    <Frame title="Where each month's sales go" note={note} legend={legend} tip={tip}>
      <svg viewBox={`0 0 ${W} ${H}`} className="adv-svg" onMouseLeave={hide}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={TOP - 6} y2={yAxis} className="adv-grid" />
            <text x={x(v)} y={yAxis + 18} textAnchor="middle" className="adv-tick">{usd(v)}</text>
          </g>
        ))}
        {sites.map((t, i) => {
          const y = TOP + i * ROW + ROW / 2
          const v = parts(t)
          const loss = v.net < 0
          const segs = PARTS.filter((p) => p.key !== 'net' || !loss)
          let acc = 0
          const shapes = segs.map((p, k) => {
            const val = v[p.key]
            const x0 = x(acc), x1 = x(acc + val)
            acc += val
            const w = Math.max(0, x1 - x0 - (k < segs.length - 1 ? GAP : 0))
            const label = `${p.label} at ${t.block.street.label} · ${pct(val / t.pnl.revenue)} of monthly sales`
            const common = {
              fill: p.color, tabIndex: 0, className: 'adv-seg',
              onMouseMove: (e: MouseEvent<SVGElement>) => at(e, `${usdFull(val)} / mo`, label),
              onFocus: (e: FocusEvent<SVGElement>) => at(e, `${usdFull(val)} / mo`, label), onBlur: hide,
            }
            return k === segs.length - 1
              ? <path key={p.key} d={roundedEnd(x0, y - BAR / 2, w, BAR, 4)} {...common} />
              : <rect key={p.key} x={x0} y={y - BAR / 2} width={w} height={BAR} {...common} />
          })
          return (
            <g key={t.id}>
              <SiteLabel t={t} i={i} y={y} />
              {shapes}
              {loss && <line x1={x(t.pnl.revenue)} x2={x(t.pnl.revenue)} y1={y - BAR / 2 - 4} y2={y + BAR / 2 + 4} className="adv-ref" />}
              <text x={x(acc) + 8} y={y + 4} className="adv-value-text start">{loss ? `loss ${usd(-v.net)}/mo` : `net ${usd(v.net)}/mo`}</text>
            </g>
          )
        })}
      </svg>
      <p className="adv-key">Steady-state month (after the ramp-up), central assumptions.{sites.some((t) => t.pnl.net < 0) ? ' Tick = monthly sales where costs exceed them.' : ''}</p>
    </Frame>
  )
}

/** The same numbers as the three charts, as a table. */
export function ChartTable({ report }: { report: Report }) {
  const m = (v: number) => (Number.isFinite(v) && v <= report.horizon ? `${monthsNum(v)} mo` : `${report.horizon}+ mo`)
  return (
    <details className="adv-table">
      <summary>Show these numbers as a table</summary>
      <table>
        <thead>
          <tr>
            <th>Site</th><th>Startup (good / typical / cautious)</th><th>Payback (good / typical / cautious)</th>
            <th>Monthly sales</th><th>Food & drink</th><th>Labor</th><th>Rent incl. NNN</th><th>Other</th><th>Net cash flow</th>
          </tr>
        </thead>
        <tbody>
          {report.top.map((t, i) => (
            <tr key={t.id}>
              <td>#{i + 1} {t.block.street.label}</td>
              <td>{usd(t.startup.p10)} / {usd(t.startup.p50)} / {usd(t.startup.p90)}</td>
              <td>{m(t.payback.p10)} / {m(t.payback.p50)} / {m(t.payback.p90)}</td>
              <td>{usd(t.pnl.revenue)}</td><td>{usd(t.pnl.food)}</td><td>{usd(t.pnl.labor)}</td><td>{usd(t.pnl.rent)}</td>
              <td>{usd(t.pnl.other)}</td><td>{usd(t.pnl.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
