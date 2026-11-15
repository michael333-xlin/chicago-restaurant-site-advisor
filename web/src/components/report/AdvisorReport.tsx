import { useEffect, useMemo, useState } from 'react'
import { fetchNarrative, type Narrative } from '../../data/blocks'
import { buildNarrativePayload } from '../../model/narrativePayload'
import type { Assumption, Report } from '../../types'
import { ChartTable, MonthlyChart, PaybackChart, StartupChart } from './AdvisorCharts'

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; data: Narrative }

function List({ title, items, ordered = false }: { title: string; items: string[]; ordered?: boolean }) {
  if (!Array.isArray(items) || !items.length) return null
  const body = items.map((x, i) => <li key={i}>{x}</li>)
  return (
    <div className="adv-list">
      <h4>{title}</h4>
      {ordered ? <ol>{body}</ol> : <ul>{body}</ul>}
    </div>
  )
}

const LEVEL_TEXT = { high: 'High', medium: 'Medium', low: 'Low' } as const

/** Plain-English report: DeepSeek writes the text from this analysis' model results (server: /api/report);
 *  the charts beside it are drawn from the same results. Mounted with a key per analysis. */
export default function AdvisorReport({ report, assumptions }: { report: Report; assumptions: Assumption[] }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  // the facts are frozen when the report is built; later edits to assumptions apply after "Recalculate"
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const payload = useMemo(() => buildNarrativePayload(report, assumptions), [report])

  useEffect(() => {
    let alive = true
    fetchNarrative(payload)
      .then((data) => alive && setState({ status: 'done', data }))
      .catch((e: Error) => alive && setState({ status: 'error', message: e.message }))
    return () => {
      alive = false
    }
  }, [payload])

  if (state.status === 'loading')
    return (
      <div className="advisor loading">
        <span className="adv-spinner" />
        Writing your plain-English report from the model results (about half a minute; a second pass runs if a check fails)…
      </div>
    )
  if (state.status === 'error')
    return (
      <div className="advisor">
        <p className="muted">The plain-English report could not be written: {state.message}</p>
      </div>
    )
  const { report: r, unverified_numbers: bad, problems, revised, model, generated_at: at, reference_facts: refs } = state.data
  const hasSites = report.top.length > 0
  return (
    <div className="advisor">
      <h3 className="adv-headline">{r.headline}</h3>
      <p className="lead">{r.bottom_line}</p>
      <p className="adv-request">{r.your_request}</p>
      {r.fit_for_you && (
        <div className="adv-callout">
          <span className="adv-tag">Is this a fit for you?</span>
          {r.fit_for_you}
        </div>
      )}

      {hasSites && (
        <>
          <h4 className="adv-section">Your sites at a glance</h4>
          <div className="adv-charts">
            <StartupChart report={report} note={r.chart_notes.startup_cost} />
            <PaybackChart report={report} note={r.chart_notes.payback} />
            <MonthlyChart report={report} note={r.chart_notes.monthly_money} />
          </div>
          <ChartTable report={report} />
        </>
      )}

      {r.sites.length > 0 && <h4 className="adv-section">Site by site</h4>}
      <div className="adv-sites">
        {r.sites.map((s, i) => (
          <div key={i} className="adv-site">
            <div className="adv-site-head">
              <span className="rank-badge sm">#{i + 1}</span>
              <div>
                <b>{s.name}</b>
                {s.best_for && <span className="adv-best">Best for: {s.best_for}</span>}
              </div>
            </div>
            <p className="adv-verdict">{s.verdict}</p>
            <p><span className="adv-tag">Why here</span>{s.why_here}</p>
            <p><span className="adv-tag">The money</span>{s.money}</p>
            <p><span className="adv-tag">Watch out</span>{s.watch_out}</p>
          </div>
        ))}
      </div>

      {r.comparison && (
        <div className="adv-block">
          <h4>How the sites compare</h4>
          <p>{r.comparison}</p>
        </div>
      )}
      <List title="What would change the answer" items={r.what_would_change_the_answer} />

      {r.risks.length > 0 && (
        <div className="adv-block">
          <h4>Risks to keep in mind</h4>
          <div className="adv-risks">
            {r.risks.map((x, i) => (
              <div key={i} className={`adv-risk ${x.level}`}>
                <div className="adv-risk-head">
                  <span className={`adv-level ${x.level}`}><i />{LEVEL_TEXT[x.level]}</span>
                  <b>{x.risk}</b>
                </div>
                {x.why_it_matters && <p>{x.why_it_matters}</p>}
                {x.what_to_do && <p className="adv-todo"><span className="adv-tag">What to do</span>{x.what_to_do}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="adv-grid">
        <List title="Next steps" items={r.next_steps} ordered />
        <List title="Questions to ask before you sign" items={r.questions_to_ask} />
        <List title="Chicago checklist: licenses, permits, payroll, lease" items={r.chicago_checklist} />
        <List title="How to read the numbers" items={r.how_to_read_the_numbers} />
        <List title="Where the data comes from" items={r.data_and_limits} />
      </div>

      {refs.length > 0 && (
        <details className="adv-refs">
          <summary>Sources behind the checklist ({refs.length})</summary>
          <ul>
            {refs.map((f, i) => (
              <li key={i}>
                {f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.source}</a> : f.source} <span className="muted">· {f.topic}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className={`adv-foot ${bad.length || problems.length ? 'warn' : ''}`}>
        Written by {model} from this report's model results ({new Date(at).toLocaleString('en-US')}){revised ? ', revised once after the automatic checks' : ''}. The text
        explains the numbers; it does not create them. This is a planning aid, not legal, tax or financial advice.{' '}
        {bad.length
          ? `${bad.length} number${bad.length > 1 ? 's' : ''} in the text could not be traced to the model results: ${bad.map((b) => b.number).join(', ')}. Treat ${bad.length > 1 ? 'them' : 'it'} with caution.`
          : 'Every number in the text was checked against the model results.'}
        {problems.length ? ` Incomplete: ${problems.join(' ')}` : ''}
      </p>
    </div>
  )
}
