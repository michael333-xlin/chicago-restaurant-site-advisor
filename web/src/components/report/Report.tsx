import { useEffect, useRef, useState } from 'react'
import { GapMatrix, Scatter } from '../../charts/Charts'
import { RANK_COLORS } from '../../colors'
import { dataMeta, dataNotice } from '../../data/blocks'
import {
  CUISINE_LABEL, FORMAT_LABEL, RISK_LABEL, RISK_RULE, STOREFRONT_LABEL, type Assumption, type Report as R,
} from '../../types'
import { monthsNum, num, usd } from '../../format'
import { CountUp, Reveal } from '../../ui'
import ErrorBoundary from '../ErrorBoundary'
import AdvisorReport from './AdvisorReport'
import Assumptions from './Assumptions'
import SiteDeepDive, { Flags } from './SiteDeepDive'

export type Focus = 'summary' | 'site' | 'compare' | 'zip'

const SECTIONS: { id: string; label: string; focus: Focus }[] = [
  { id: 'plain', label: 'Plain-English report', focus: 'summary' },
  { id: 'summary', label: 'Summary', focus: 'summary' },
  { id: 'sites', label: 'Site deep-dive', focus: 'site' },
  { id: 'compare', label: 'Same-budget comparison', focus: 'compare' },
  { id: 'assumptions', label: 'Assumptions', focus: 'zip' },
  { id: 'methods', label: 'Method & limits', focus: 'zip' },
]

type Props = {
  report: R
  assumptions: Assumption[]
  onAssumptions: (a: Assumption[]) => void
  dirty: boolean
  onRecalc: () => void
  site: number
  onSite: (i: number) => void
  onFocus: (f: Focus) => void
  onEdit: () => void
}

function PaybackRange({ p, horizon }: { p: R['top'][number]['payback']; horizon: number }) {
  const cap = (v: number) => (Number.isFinite(v) ? Math.min(v, horizon) : horizon)
  const x = (v: number) => `${(cap(v) / horizon) * 100}%`
  return (
    <div className="pb-range">
      <div className="pb-track">
        <div className="pb-band" style={{ left: x(p.p10), width: `calc(${x(p.p90)} - ${x(p.p10)})` }} />
        <div className="pb-mid" style={{ left: x(p.p50) }} />
      </div>
      <div className="pb-labels">
        <span>{monthsNum(p.p10)}</span>
        <b>{monthsNum(p.p50)} mo</b>
        <span>{monthsNum(p.p90)}</span>
      </div>
    </div>
  )
}

export default function Report({ report, assumptions, onAssumptions, dirty, onRecalc, site, onSite, onFocus, onEdit }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('plain')
  const { inputs, top } = report

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const els = SECTIONS.map((s) => root.querySelector<HTMLElement>(`#sec-${s.id}`)).filter((e): e is HTMLElement => !!e)
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (!hit) return
        const id = hit.target.id.replace('sec-', '')
        setActive(id)
        const s = SECTIONS.find((x) => x.id === id)
        if (s) onFocus(s.focus)
      },
      { root, rootMargin: '-30% 0px -60% 0px', threshold: [0, 0.01] },
    )
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [onFocus, top.length])

  const go = (id: string) => scrollRef.current?.querySelector(`#sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const openSite = (i: number) => {
    onSite(i)
    go('sites')
  }
  const best = top[0]

  return (
    <div className="report" ref={scrollRef}>
      <nav className="report-nav">
        {SECTIONS.filter((s) => s.id !== 'sites' || top.length).map((s) => (
          <button key={s.id} className={active === s.id ? 'on' : ''} onClick={() => go(s.id)}>{s.label}</button>
        ))}
        <button className="ghost-btn" onClick={onEdit}>Edit inputs</button>
      </nav>

      <header className="report-head">
        <div className="badges">
          <span className="flag warn">Draft · consultant review required before sharing</span>
          <span className="flag info">{dataNotice()}</span>
        </div>
        <h1>
          Site report · <span className="grad">{report.zip.zip}</span> <span className="muted">{report.zip.name}</span>
        </h1>
        <div className="chips static">
          <span className="chip on">{CUISINE_LABEL[inputs.cuisine]}</span>
          <span className="chip on">{FORMAT_LABEL[inputs.format]}</span>
          <span className="chip on">{usd(inputs.budgetMin)}–{usd(inputs.budgetMax)} total startup</span>
          <span className="chip on">{inputs.sqftMin.toLocaleString()}–{inputs.sqftMax.toLocaleString()} sq ft</span>
          <span className="chip on">{inputs.storefront === 'both' ? 'Vacant + second-gen' : STOREFRONT_LABEL[inputs.storefront]}</span>
          <span className="chip on">{inputs.liquor ? 'Liquor license' : 'No liquor'}</span>
          <span className="chip on">{inputs.dayparts.map((d) => d.replace('_', ' ')).join(' · ')}</span>
          <span className="chip on">{RISK_LABEL[inputs.risk]}</span>
        </div>
      </header>

      <section id="sec-plain" className="section">
        <div className="sec-title"><span>00</span><h2>Plain-English report</h2></div>
        <Reveal className="card wide">
          <ErrorBoundary key={report.generatedAt} label="The plain-English report">
            <AdvisorReport report={report} assumptions={assumptions} />
          </ErrorBoundary>
        </Reveal>
      </section>

      <section id="sec-summary" className="section">
        <div className="sec-title"><span>01</span><h2>Summary</h2></div>
        <Reveal>
          {best && !report.topOverBudget ? (
            <p className="lead">
              Best fit for a {RISK_LABEL[inputs.risk].toLowerCase()} investor: a <b>{best.sqft.toLocaleString()} sq ft {STOREFRONT_LABEL[best.storefront].toLowerCase()}</b> near{' '}
              <b>{best.block.street.label}</b>, which pays back in <b>{monthsNum(best.payback.p50)} months</b> in the base case ({monthsNum(best.payback.p10)} optimistic, {monthsNum(best.payback.p90)} conservative) on a{' '}
              <b>{usd(best.startup.p50)}</b> startup budget.
            </p>
          ) : null}
          {best && report.topOverBudget ? (
            <p className="lead">
              No plan fits a {usd(inputs.budgetMax)} ceiling in {report.zip.zip}. The {top.length} plans closest to the budget are simulated in full below and flagged{' '}
              <b>over budget</b>; the cheapest, a {best.sqft.toLocaleString()} sq ft {STOREFRONT_LABEL[best.storefront].toLowerCase()} near <b>{best.block.street.label}</b>, needs about{' '}
              <b>{usd(best.startup.p50)}</b> and pays back in <b>{monthsNum(best.payback.p50)} months</b> in the base case. Try a higher budget, a smaller floor area, or second-gen spaces.
            </p>
          ) : !best ? (
            <p className="lead">
              No plan fits a {usd(inputs.budgetMax)} ceiling in {report.zip.zip}. The cheapest simulated plan
              {report.cheapest ? <> ({report.cheapest.sqft.toLocaleString()} sq ft {STOREFRONT_LABEL[report.cheapest.storefront].toLowerCase()} near {report.cheapest.block.street.label}) needs about <b>{usd(report.cheapest.startup.p50)}</b></> : ' could not be built'}.
              Try a higher budget, a smaller floor area, or allowing second-gen spaces.
            </p>
          ) : null}
        </Reveal>
        <div className="stat-strip">
          <div><b><CountUp value={report.stats.blocks} format={num} /></b><span>blocks mapped</span></div>
          <div><b><CountUp value={report.stats.screened} format={num} /></b><span>plans screened</span></div>
          <div><b><CountUp value={report.stats.simulated * report.draws} format={num} /></b><span>simulated futures</span></div>
          <div><b><CountUp value={report.stats.feasible} format={num} /></b><span>plans within budget</span></div>
        </div>
        <div className="top-cards">
          {top.map((t, i) => (
            <Reveal key={t.id} delay={i * 120} className="top-card-wrap">
              <button className="top-card" onClick={() => openSite(i)} style={{ ['--accent' as string]: `rgb(${RANK_COLORS[i].join(',')})` }}>
                <div className="tc-head">
                  <span className="rank-badge sm">#{i + 1}</span>
                  <div>
                    <b>{t.block.street.label}</b>
                    <span className="mono muted">{t.block.street.grid}</span>
                  </div>
                </div>
                <div className="tc-line">{FORMAT_LABEL[t.format]} · {t.sqft.toLocaleString()} sq ft · {STOREFRONT_LABEL[t.storefront]}</div>
                <div className="tc-label">Payback · optimistic / base / conservative</div>
                <PaybackRange p={t.payback} horizon={report.horizon} />
                <div className="tc-grid">
                  <div><span>Startup P50</span><b>{usd(t.startup.p50)}</b></div>
                  <div><span>Check</span><b>${t.ticket.low}–{t.ticket.high}</b></div>
                  <div><span>Competition</span><b>{t.competition.level}</b></div>
                  <div><span>Profit / yr</span><b>{usd(t.annualProfitP50)}</b></div>
                </div>
                <div className="tc-flags"><Flags plan={t} /></div>
                <div className="tc-go">Open deep-dive →</div>
              </button>
            </Reveal>
          ))}
        </div>
      </section>

      {top.length > 0 && (
        <section id="sec-sites" className="section">
          <div className="sec-title"><span>02</span><h2>Site deep-dive</h2></div>
          <SiteDeepDive report={report} index={Math.min(site, top.length - 1)} onIndex={onSite} />
        </section>
      )}

      <section id="sec-compare" className="section">
        <div className="sec-title"><span>03</span><h2>Same-budget comparison</h2></div>
        <Reveal className="card wide">
          <div className="eyebrow">Every simulated plan</div>
          <h4>Payback vs. risk</h4>
          <Scatter report={report} onPick={openSite} />
        </Reveal>
        <Reveal className="card wide">
          <div className="eyebrow">Unmet demand within ~300 m (expected − open restaurants)</div>
          <h4>Would another concept do better on the same blocks?</h4>
          <GapMatrix report={report} />
          <p className="muted small">Warm = more demand than restaurants; cool = saturated. Outlined cell = strongest concept on that block. The highlighted column is the concept you asked for.</p>
        </Reveal>
      </section>

      <section id="sec-assumptions" className="section">
        <div className="sec-title"><span>04</span><h2>Assumptions</h2></div>
        <Reveal className="card wide">
          <p className="muted small">Every number the model uses, with its source and status. Edit any value and recalculate; edited rows are flagged in the report.</p>
          <Assumptions list={assumptions} onChange={onAssumptions} dirty={dirty} onRecalc={onRecalc} />
        </Reveal>
      </section>

      <section id="sec-methods" className="section">
        <div className="sec-title"><span>05</span><h2>Method &amp; limits</h2></div>
        <Reveal className="card wide prose">
          <h4>How the numbers are made</h4>
          <p>
            All figures come from deterministic code; nothing is written by a language model. The ZIP is split into H3 resolution-10 blocks (about one city block each), and demand and
            competition are summed over each block and its two surrounding rings (~300 m). Blocks with no active food business within ~150 m are skipped as non-commercial.
          </p>
          <p>
            Stage 1 screens every block × floor size ({[...new Set(report.plans.map((p) => p.sqft))].map((s) => s.toLocaleString()).join(' / ')} sq ft) × storefront type with central assumptions and keeps the best
            12 blocks, at least ~400 m apart. Stage 2 runs {num(report.draws)} Monte Carlo draws per plan: every assumption is drawn from its triangular range, revenue ramps up over the first months,
            and payback is the month cumulative net cash flow first covers the full startup cost (including the working-capital reserve). P10 / P50 / P90 are the optimistic, base and conservative cases.
          </p>
          <p>
            Daily guests = min(capacity, demand). Capacity is seats × turns × occupancy for full service, or a throughput limit per sq ft otherwise. Demand is the unit revenue benchmark ÷ average check,
            scaled by the block's expected-vs-open ratio for the concept (bounded) and by the chosen dayparts. Plans whose P50 startup cost exceeds the budget ceiling are dropped; P90 above the ceiling
            is flagged as overrun risk; P50 below the floor is flagged as budget headroom. Ranking uses {RISK_RULE[inputs.risk]}, keeping one plan per block.
          </p>
          <p>
            Survival: a logistic model trained on Chicago Business License openings 2013–2022 estimates the chance that a new independent dine-in restaurant still holds its license after 1,000 days
            (rolling out-of-time AUC {dataMeta()?.survivalModel.aucIndependent ?? '—'} for independents, Brier {dataMeta()?.survivalModel.brier ?? '—'} vs {dataMeta()?.survivalModel.brierConstant ?? '—'} for a constant).
            Its inputs are ZIP context, ZIP survival history, cuisine, operator experience and the address's license history; operator and address inputs you leave blank use the ZIP average of
            recent independent openings. This ZIP: {Math.round(report.survival.p * 100)}%{report.survival.source === 'api' ? ' with your inputs' : ''}. "Pays back while licensed" combines each payback draw
            with a Kaplan–Meier curve of license durations scaled to that estimate (proportional hazards). The estimate is not used in the ranking.
          </p>
          <h4>Where the block data comes from</h4>
          <ul className="sources">
            {Object.entries(dataMeta()?.sources ?? {}).map(([k, v]) => (
              <li key={k}><b>{k.replace(/_/g, ' ')}</b>: {v}</li>
            ))}
          </ul>
          <p>
            Expected restaurants per block = restaurants within ~300 m × the cuisine share that ZIPs with similar population, jobs, income and age mix
            support (leave-one-ZIP-out Poisson model). Gap-model fit for this cuisine: correlation {(dataMeta()?.gapReliability[inputs.cuisine] ?? 0).toFixed(2)}
            {(dataMeta()?.gapReliability[inputs.cuisine] ?? 1) < 0.4 ? ' — weak, treat the demand gap as indicative only' : ''}. Rent is ZIP level: the team survey of 7 neighborhoods,
            otherwise the median of those surveys (flagged in the risks). Data snapshot {dataMeta()?.snapshotId ?? '—'}, exported {dataMeta()?.generatedAt ?? '—'}.
          </p>
          <p>
            Revenue is the weakest link: there is no POS data and no consultant project history, so revenue is a public-benchmark estimate and every revenue and payback figure is{' '}
            <b>not calibrated to local operating data</b>. Every benchmark in the assumptions table shows its source and status (sourced, partly sourced with the derivation, or no public source); hover a source for the derivation. The demand model's ability to predict
            where restaurants exist is not the same as predicting which restaurant makes money. The plain-English report at the top is written by a language model
            (DeepSeek) from these model results only; every number in it is checked against them. Equipment condition, key money and license transfer for second-gen spaces need a site visit and negotiation.
          </p>
          <p className="disclaimer">Payback periods are scenarios under stated assumptions, not promises. This draft must be reviewed by a consultant before it is shared with a client.</p>
        </Reveal>
      </section>
      <footer className="report-foot muted">Generated {new Date(report.generatedAt).toLocaleString('en-US')} · OpeningTable prototype</footer>
    </div>
  )
}
