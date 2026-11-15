import { useState } from 'react'
import type { Assumption, Range3 } from '../../types'

const PCT_UNITS = new Set(['%', '% rev', '% wages', '% of new'])

function toDisplay(a: Assumption, v: number) {
  return PCT_UNITS.has(a.unit) ? +(v * 100).toFixed(2) : +v.toFixed(v >= 100 ? 0 : 2)
}
function fromDisplay(a: Assumption, v: number) {
  return PCT_UNITS.has(a.unit) ? v / 100 : v
}

function NumCell({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const commit = () => {
    if (text != null) {
      const v = parseFloat(text)
      if (!Number.isNaN(v) && v !== value) onCommit(v)
    }
    setText(null)
  }
  return (
    <input
      inputMode="decimal"
      value={text ?? String(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

type Props = { list: Assumption[]; onChange: (list: Assumption[]) => void; dirty: boolean; onRecalc: () => void }

export default function Assumptions({ list, onChange, dirty, onRecalc }: Props) {
  const groups = [...new Set(list.map((a) => a.group))]
  const edit = (key: string, i: 0 | 1 | 2, display: number) => {
    onChange(
      list.map((a) => {
        if (a.key !== key) return a
        const v = [...a.value] as Range3
        v[i] = fromDisplay(a, display)
        if (v[0] > v[1]) v[0] = v[1]
        if (v[2] < v[1]) v[2] = v[1]
        return { ...a, value: v, edited: true }
      }),
    )
  }
  const count = (st: Assumption['status']) => list.filter((a) => a.status === st).length
  const edited = list.filter((a) => a.edited).length
  return (
    <div className="assumptions">
      <div className="as-bar">
        <span>
          <b>{list.length}</b> parameters · <b className="ok">{count('sourced')}</b> sourced · <b className="ok">{count('partial')}</b> partly sourced ·{' '}
          <b className="warn">{count('unsourced')}</b> no public source
          {edited > 0 && <> · <b className="edit">{edited}</b> edited by consultant</>}
        </span>
        <button className={`cta small ${dirty ? '' : 'idle'}`} disabled={!dirty} onClick={onRecalc}>
          <span>{dirty ? 'Recalculate report' : 'Edit any value to recalculate'}</span>
        </button>
      </div>
      {groups.map((g) => (
        <div key={g} className="as-group">
          <div className="eyebrow">{g}</div>
          <table>
            <thead>
              <tr><th>Parameter</th><th>Low</th><th>Most likely</th><th>High</th><th>Unit</th><th>Source</th><th>Status</th></tr>
            </thead>
            <tbody>
              {list.filter((a) => a.group === g).map((a) => (
                <tr key={a.key} className={a.edited ? 'edited' : ''}>
                  <td>{a.label}</td>
                  {([0, 1, 2] as const).map((i) => (
                    <td key={i}>
                      <NumCell value={toDisplay(a, a.value[i])} onCommit={(v) => edit(a.key, i, v)} />
                    </td>
                  ))}
                  <td className="muted">{a.unit}</td>
                  <td className="src" title={a.note}>
                    {a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.source}</a> : a.source}
                    {a.date !== '—' && <em>{a.date}</em>}
                  </td>
                  <td>
                    <span className={`flag ${a.edited ? 'edit' : a.status === 'unsourced' ? 'warn' : 'ok'}`} title={a.note}>
                      {a.edited ? 'Edited' : a.status === 'sourced' ? 'Sourced' : a.status === 'partial' ? 'Partly sourced' : 'No source'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
