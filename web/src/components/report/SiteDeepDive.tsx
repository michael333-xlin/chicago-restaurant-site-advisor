import { lazy, Suspense } from 'react'
import MonteCarloDrop from '../../charts/MonteCarloDrop'
import { FanChart, Gauge, StartupBar, Tornado, Waterfall } from '../../charts/Charts'
import { RANK_COLORS } from '../../colors'
import { CUISINE_LABEL, CUISINE_SHORT, FORMAT_LABEL, STOREFRONT_LABEL, type Plan, type PlanDetail, type Report } from '../../types'
import { months, monthsNum, num, pct, usd, usdFull } from '../../format'
import { CountUp, Reveal } from '../../ui'

const Storefront3D = lazy(() => import('../Storefront3D'))

const FLAG_TEXT: Record<Plan['flags'][number], { text: string; tone: 'warn' | 'info' | 'bad' }> = {
  overrun_risk: { text: 'Overrun risk', tone: 'warn' },
  budget_headroom: { text: 'Budget headroom', tone: 'info' },
  same_address_closures: { text: 'Same address closed repeatedly', tone: 'bad' },
  space_unconfirmed: { text: 'Space availability unconfirmed', tone: 'info' },
}

export function Flags({ plan }: { plan: Plan }) {
  return (
    <>
      {plan.flags.map((f) => (
        <span key={f} className={`flag ${FLAG_TEXT[f].tone}`}>{FLAG_TEXT[f].text}</span>
      ))}
    </>
  )
}

function Block({ title, eyebrow, children, className = '' }: { title: string; eyebrow?: string; children: React.ReactNode; className?: string }) {
  return (
    <Reveal className={`card ${className}`}>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h4>{title}</h4>
      {children}
    </Reveal>
  )
}

function Compare({ a, b, horizon }: { a: Plan; b: Plan | null; horizon: number }) {
  if (!b) return null
  const rows: { label: string; f: (p: Plan) => string; better: (x: Plan, y: Plan) => boolean }[] = [
    { label: 'Startup cost (P50)', f: (p) => usd(p.startup.p50), better: (x, y) => x.startup.p50 < y.startup.p50 },
    { label: 'Startup cost (P90)', f: (p) => usd(p.startup.p90), better: (x, y) => x.startup.p90 < y.startup.p90 },
    { label: 'Payback optimistic / base / conservative', f: (p) => `${monthsNum(p.payback.p10)} / ${monthsNum(p.payback.p50)} / ${monthsNum(p.payback.p90)} mo`, better: (x, y) => x.payback.p50 < y.payback.p50 },
    { label: 'No payback within 5 yrs', f: (p) => pct(p.noPaybackProb), better: (x, y) => x.noPaybackProb < y.noPaybackProb },
    { label: 'Annual profit (P50)', f: (p) => usd(p.annualProfitP50), better: (x, y) => x.annualProfitP50 > y.annualProfitP50 },
    { label: 'Within budget', f: (p) => (p.feasible ? 'Yes' : 'No'), better: (x, y) => x.feasible && !y.feasible },
  ]
  const plans = [a, b].sort((x, y) => (x.storefront === 'vacant' ? 0 : 1) - (y.storefront === 'vacant' ? 0 : 1))
  return (
    <div className="compare">
      <div className="cmp-row head">
        <div />
        {plans.map((p) => (
          <div key={p.id} className={p.id === a.id ? 'chosen' : ''}>
            {STOREFRONT_LABEL[p.storefront]}
            {p.id === a.id && <em>recommended</em>}
          </div>
        ))}
      </div>
      {rows.map((r) => (
        <div className="cmp-row" key={r.label}>
          <div className="muted">{r.label}</div>
          {plans.map((p) => {
            const other = plans.find((o) => o.id !== p.id)!
            return (
              <div key={p.id} className={r.better(p, other) ? 'win' : ''}>{r.f(p)}</div>
            )
          })}
        </div>
      ))}
      <p className="muted small">
        {b.storefront === 'second_gen' || a.storefront === 'second_gen'
          ? `Second-gen option generated because: ${(a.secondGenEvidence ?? b.secondGenEvidence) || 'recent closures nearby'}. Horizon ${horizon} months.`
          : null}
      </p>
    </div>
  )
}

export default function SiteDeepDive({ report, index, onIndex }: { report: Report; index: number; onIndex: (i: number) => void }) {
  const t: PlanDetail = report.top[index]
  const { inputs } = report
  const color = RANK_COLORS[index]
  const accent = `rgb(${color.join(',')})`
  const cs = t.block.cuisine[inputs.cuisine]
  const hourly = t.staff.filter((s) => !s.salaried)
  const laborTotal = t.pnl.labor
  return (
    <div className="deep" style={{ ['--accent' as string]: accent }}>
      <div className="site-tabs">
        {report.top.map((p, i) => (
          <button key={p.id} className={i === index ? 'on' : ''} onClick={() => onIndex(i)} style={{ ['--accent' as string]: `rgb(${RANK_COLORS[i].join(',')})` }}>
            <b>#{i + 1}</b>
            <span>{p.block.street.label}</span>
          </button>
        ))}
      </div>

      <Reveal className="site-head" key={`head-${t.id}`}>
        <div className="rank-badge">#{index + 1}</div>
        <div>
          <h3>{t.block.street.label}</h3>
          <div className="muted">
            {t.block.street.ns} · {t.block.street.ew} · <span className="mono">{t.block.street.grid}</span>
          </div>
          <div className="chips static">
            <span className="chip on">{FORMAT_LABEL[t.format]}</span>
            <span className="chip on">{t.sqft.toLocaleString()} sq ft</span>
            <span className="chip on">{STOREFRONT_LABEL[t.storefront]}</span>
            <span className="chip on">{t.seats} seats</span>
            <Flags plan={t} />
          </div>
        </div>
      </Reveal>

      <div className="kpis" key={`kpi-${t.id}`}>
        <div className="kpi"><span>Startup (P50)</span><b><CountUp value={t.startup.p50} format={usd} /></b><em>P10–P90 {usd(t.startup.p10)}–{usd(t.startup.p90)}</em></div>
        <div className="kpi"><span>Base-case payback</span><b>{Number.isFinite(t.payback.p50) ? <CountUp value={t.payback.p50} format={(v) => `${Math.round(v)} mo`} /> : '> 72 mo'}</b><em>{monthsNum(t.payback.p10)} – {monthsNum(t.payback.p90)} mo range</em></div>
        <div className="kpi"><span>Annual profit (P50)</span><b><CountUp value={t.annualProfitP50} format={usd} /></b><em>steady state, year 2+</em></div>
        <div className="kpi"><span>Recommended check</span><b>${t.ticket.low}–${t.ticket.high}</b><em>per guest · income pct {Math.round(t.block.incomePct)}</em></div>
        <div className="kpi"><span>Competition</span><b>{t.competition.score}</b><em>{t.competition.level} pressure</em></div>
      </div>

      <Block title="The space" eyebrow={`3D layout · ${CUISINE_LABEL[inputs.cuisine]} · ${FORMAT_LABEL[t.format]} · drag to rotate`} className="wide model-card">
        <Suspense fallback={<div className="model-loading">Loading 3D model…</div>}>
          <Storefront3D
            spec={{ sqft: t.sqft, format: t.format, cuisine: inputs.cuisine, seats: t.seats, hasBar: inputs.liquor, storefront: t.storefront }}
            height={400}
          />
        </Suspense>
        <dl className="spec">
          <div><dt>Floor area</dt><dd>{t.sqft.toLocaleString()} sq ft <em className="tag">{t.sizeTier === 'S' ? 'small' : t.sizeTier === 'M' ? 'medium' : 'large'} tier</em></dd></div>
          <div><dt>Dining seats (model)</dt><dd>{t.seats}</dd></div>
          <div><dt>Guests per day</dt><dd>{num(t.coversPerDay)} <em className="tag">{t.capacityBound ? 'capacity-bound' : 'demand-bound'}</em></dd></div>
          <div><dt>Average check</dt><dd>${t.ticket.mid} <span className="muted">(${t.ticket.low}–${t.ticket.high})</span></dd></div>
          <div><dt>Monthly revenue</dt><dd>{usd(t.pnl.revenue)} steady state</dd></div>
          <div><dt>Rent estimate</dt><dd>${t.block.rentPsf}/sq ft/yr · {usd(t.rentMonthly)}/mo incl. NNN</dd></div>
          <div className="span2"><dt>Storefront</dt><dd>{STOREFRONT_LABEL[t.storefront]}{t.secondGenEvidence ? ` — ${t.secondGenEvidence}` : ''}</dd></div>
        </dl>
        <p className="muted small">
          The 3D layout is illustrative: aisles, the bar and the service zone can leave room for fewer tables than the financial model's seat count. Price check vs. nearby menus needs the live
          competitor search (phase 2); price elasticity is not modelled — the tornado below shows what ±10% on the check does to payback.
        </p>
      </Block>

      <Block title="When does it pay back?" eyebrow={`Payback · ${num(report.draws)} simulations`} className="wide">
        <MonteCarloDrop key={t.id} samples={t.samples} horizon={report.horizon} />
        <div className="scenarios">
          <div className="sc opt"><span>Optimistic · P10</span><b>{months(t.payback.p10)}</b></div>
          <div className="sc base"><span>Base · P50</span><b>{months(t.payback.p50)}</b></div>
          <div className="sc cons"><span>Conservative · P90</span><b>{months(t.payback.p90)}</b></div>
          <div className="sc never"><span>No payback in 5 yrs</span><b>{pct(t.noPaybackProb)}</b></div>
        </div>
      </Block>

      <Block title="Cumulative cash position" eyebrow="P10–P90 band across all draws, ramp-up included" className="wide">
        <FanChart key={t.id} fan={t.fan} horizon={report.horizon} payback={t.payback} />
      </Block>

      <div className="grid-2">
        <Block title="Competition pressure" eyebrow="0–100 · four components">
          <div className="comp">
            <Gauge key={t.id} value={t.competition.score} label={t.competition.level} sub={`${CUISINE_SHORT[inputs.cuisine]} within ~300 m`} />
            <div className="parts">
              {t.competition.parts.map((p) => (
                <div key={p.key} className="part">
                  <div className="part-top"><span>{p.label}</span><b>{p.score}</b></div>
                  <div className="bar"><div style={{ width: `${p.score}%` }} /></div>
                  <em>{p.detail}</em>
                </div>
              ))}
            </div>
          </div>
        </Block>
        <Block title="Target customers" eyebrow={`Cuisine fit ${t.persona.fit}/100`}>
          <div className="persona-head">{t.persona.headline}</div>
          <ul className="tags">
            {t.persona.tags.map((g) => (
              <li key={g.label}><b>{g.label}</b><span>{g.detail}</span></li>
            ))}
          </ul>
          <div className="drivers">
            {t.persona.drivers.map((d) => (
              <div key={d.label} className="drv">
                <span>{d.label}</span>
                <div className="bar"><div style={{ width: `${d.pct}%` }} /></div>
                <b>{d.pct}</b>
              </div>
            ))}
          </div>
          <p className="muted small">Percentiles vs. citywide blocks. Uses spending-related traits only (income, age, workers, students, visitors, transit), never race or ethnicity.</p>
        </Block>
      </div>

      <div className="grid-2">
        <Block title="Rent" eyebrow="Model estimate vs. live listings">
          <div className="rent">
            <div><span>Base rent</span><b>${t.block.rentPsf}</b><em>/sq ft/yr</em></div>
            <div><span>Monthly incl. NNN</span><b>{usd(t.rentMonthly)}</b><em>{t.sqft.toLocaleString()} sq ft</em></div>
            <div className="pending"><span>Listing comparison</span><b>—</b><em>Exa listing search · phase 2</em></div>
          </div>
          <p className="muted small">Estimate from the sample rent surface; the pipeline will use Cook County Assessor commercial valuations, flagged when live listings differ.</p>
        </Block>
        <Block title="Labor" eyebrow={`${usd(laborTotal)}/mo incl. employer taxes · ${pct(laborTotal / t.pnl.revenue)} of revenue`}>
          <table className="staff">
            <thead><tr><th>Role</th><th>FTE</th><th>Pay</th><th>Monthly</th></tr></thead>
            <tbody>
              {t.staff.filter((s) => s.salaried).concat(hourly).map((s) => (
                <tr key={s.role}>
                  <td>{s.role}{s.tipped && <em className="tag">tipped</em>}</td>
                  <td>{s.fte.toFixed(1)}</td>
                  <td>{s.salaried ? `${usd(s.wage)}/yr` : `$${s.wage.toFixed(2)}/hr`}</td>
                  <td>{usdFull(s.monthly)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Chicago minimum wage $17.05/hr, tipped $12.96/hr (from 2026-07-01). Other wages are placeholders pending BLS OEWS.</p>
        </Block>
      </div>

      <Block title="Startup cost breakdown" eyebrow="Everything the budget has to cover" className="wide">
        <StartupBar key={t.id} plan={t} budgetMin={inputs.budgetMin} budgetMax={inputs.budgetMax} />
      </Block>

      <Block title="Monthly P&L at steady state" eyebrow="Central assumptions" className="wide">
        <Waterfall key={t.id} pnl={t.pnl} />
        <div className="pnl-detail">
          {t.pnl.detail.map((d) => (
            <span key={d.label}>{d.label} <b>{usd(d.value)}</b></span>
          ))}
        </div>
      </Block>

      {t.alternative && (
        <Block title="Vacant shell vs. second-gen space" eyebrow="Same block, same size" className="wide">
          <Compare a={t} b={t.alternative} horizon={report.horizon} />
        </Block>
      )}
      {!t.alternative && (
        <Block title="Storefront options" eyebrow="Vacant shell vs. second-gen" className="wide">
          <p className="muted">
            {inputs.storefront !== 'both'
              ? `Only ${STOREFRONT_LABEL[inputs.storefront as 'vacant' | 'second_gen'].toLowerCase()} plans were requested.`
              : 'No evidence of a second-generation restaurant space near this block (no recent closures), so only the vacant-shell plan was built.'}
          </p>
        </Block>
      )}

      <div className="grid-2">
        <Block title="Sensitivity" eyebrow="Payback months when one driver moves ±10%">
          <Tornado key={t.id} items={t.sensitivity} base={t.basePayback} horizon={report.horizon} />
        </Block>
        <Block title="Risks" eyebrow={`${cs.closed12m} ${CUISINE_SHORT[inputs.cuisine]} closures nearby in 12 mo`}>
          <ul className="risks">
            {t.risks.map((r) => (
              <li key={r.text} className={r.level}><i />{r.text}</li>
            ))}
          </ul>
        </Block>
      </div>

      <Block title="Evidence" eyebrow="Live web verification" className="wide">
        <ul className="evidence">
          {[
            `Retail listings near ${t.block.street.label}, ${Math.round(t.sqft * 0.8).toLocaleString()}–${Math.round(t.sqft * 1.2).toLocaleString()} sq ft, incl. second-gen restaurant spaces and key money`,
            `${CUISINE_SHORT[inputs.cuisine]} openings, closures and menu prices within ~300 m`,
            `Construction, development projects and liquor rules near ${t.block.street.label}`,
          ].map((q) => (
            <li key={q}><span className="pill">Phase 2</span>{q}<em>Exa search not connected — no claims shown without a source link.</em></li>
          ))}
        </ul>
      </Block>
    </div>
  )
}
