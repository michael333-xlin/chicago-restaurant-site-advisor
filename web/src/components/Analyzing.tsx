import { useEffect, useMemo, useState } from 'react'
import { CUISINE_LABEL, RISK_RULE, type Report } from '../types'
import { dataMeta } from '../data/blocks'
import { num, reducedMotion, usd } from '../format'

type Step = { title: string; detail: string; ms: number; pending?: boolean }

function liveStep(zip: string): Step {
  const rent = dataMeta()?.rentByZip[zip]
  if (rent?.kind === 'live') return { title: 'Live web data (Exa)', detail: `Rent from ${rent.n ?? 0} live listing${rent.n === 1 ? '' : 's'} · evidence in the site report`, ms: 500 }
  return { title: 'Live web data (Exa)', detail: 'No live listings for this ZIP yet — rent uses the survey / city median', ms: 500, pending: true }
}

function steps(r: Report): Step[] {
  const { stats, inputs, zip } = r
  const sizes = new Set(r.plans.map((p) => p.sqft)).size || 3
  const list: Step[] = [
    { title: `Loading ZIP ${zip.zip} · ${zip.name}`, detail: `${num(stats.blocks)} blocks mapped at H3 resolution 10 (~1 city block each)`, ms: 900 },
    { title: 'Finding blocks with active food businesses', detail: `${num(stats.eligible)} blocks can host a ${CUISINE_LABEL[inputs.cuisine].toLowerCase()} restaurant`, ms: 800 },
  ]
  if (inputs.liquor)
    list.push({ title: 'Liquor check: dry precincts', detail: `${num(stats.moratoriumExcluded)} blocks excluded (City of Chicago dry-precinct map, 2011 — confirm with BACP)`, ms: 600 })
  list.push(
    { title: 'Screening every plan', detail: `${num(stats.screened)} plans: blocks × ${sizes} floor sizes × storefront types`, ms: 900 },
    { title: 'Running Monte Carlo', detail: `${num(stats.simulated)} shortlisted plans × ${num(r.draws)} draws × ${r.horizon} months`, ms: 1500 },
    { title: 'Budget filter & ranking', detail: `${num(stats.feasible)} plans fit the ${usd(inputs.budgetMax)} ceiling · ranked by ${RISK_RULE[inputs.risk]}`, ms: 800 },
    liveStep(zip.zip),
    {
      title: 'Survival model',
      detail: `1,000-day license survival ${Math.round(r.survival.p * 100)}% for a new independent ${CUISINE_LABEL[inputs.cuisine].toLowerCase()} in ${zip.zip}${r.survival.source === 'api' ? ' · your inputs applied' : ' · ZIP averages'}`,
      ms: 700,
      pending: r.survival.error != null,
    },
    {
      title: !r.top.length ? 'No plan fits the budget' : r.topOverBudget ? `No plan fits · marking the ${r.top.length} closest to budget` : `Marking the top ${r.top.length} site${r.top.length > 1 ? 's' : ''}`,
      detail: r.top.length ? r.top.map((t, i) => `#${i + 1} ${t.block.street.label}${r.topOverBudget ? ` (${usd(t.startup.p50)})` : ''}`).join(' · ') : `Cheapest plan needs ~${usd(r.cheapest?.startup.p50 ?? 0)}`,
      ms: 1600,
      pending: r.topOverBudget,
    },
  )
  return list
}

type Props = { report: Report; onReveal: (n: number) => void; onDone: () => void; onOpen: () => void }

export default function Analyzing({ report, onReveal, onDone, onOpen }: Props) {
  const list = useMemo(() => steps(report), [report])
  const [active, setActive] = useState(0)
  const [mcProgress, setMcProgress] = useState(0)
  const finished = active >= list.length

  useEffect(() => {
    if (reducedMotion()) {
      setActive(list.length)
      return
    }
    if (active >= list.length) return
    const id = setTimeout(() => setActive((a) => a + 1), list[active].ms)
    return () => clearTimeout(id)
  }, [active, list])

  // Count the Monte Carlo step up while it is active.
  const mcIndex = list.findIndex((s) => s.title === 'Running Monte Carlo')
  useEffect(() => {
    if (active !== mcIndex) return
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / list[mcIndex].ms)
      setMcProgress(t)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, mcIndex, list])

  // Reveal markers one by one during the last step.
  const lastIndex = list.length - 1
  useEffect(() => {
    if (active < lastIndex) return
    const timers = report.top.map((_, i) => setTimeout(() => onReveal(i + 1), 250 + i * 420))
    return () => timers.forEach(clearTimeout)
  }, [active, lastIndex, report.top, onReveal])

  useEffect(() => {
    if (finished) onDone()
  }, [finished, onDone])

  return (
    <aside className="analyzing panel slide-in-right">
      <div className="eyebrow">Building the report</div>
      <h2>
        {report.zip.zip} <span className="muted">· {report.zip.name}</span>
      </h2>
      <ol className="timeline">
        {list.map((s, i) => {
          const state = i < active ? 'done' : i === active ? 'active' : 'todo'
          return (
            <li key={s.title} className={`${state} ${s.pending ? 'pending' : ''}`}>
              <i className="dot" />
              <div>
                <b>{s.title}</b>
                {state !== 'todo' && <span>{s.detail}</span>}
                {i === mcIndex && state !== 'todo' && (
                  <div className="mc-bar">
                    <div style={{ width: `${(state === 'done' ? 1 : mcProgress) * 100}%` }} />
                    <em>{num((state === 'done' ? 1 : mcProgress) * report.stats.simulated * report.draws)} futures</em>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <button className="cta" disabled={!finished} onClick={onOpen}>
        <span>{finished ? 'Open the full report' : 'Analyzing…'}</span>
        <i>→</i>
      </button>
    </aside>
  )
}
