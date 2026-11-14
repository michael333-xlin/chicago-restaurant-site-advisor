import { useState } from 'react'
import { SAMPLE_NOTICE, ZIP_BY_CODE, ZIPS } from '../data/sample'
import {
  CUISINE_LABEL, CUISINES, DEFAULT_FORMAT, FORMAT_LABEL, RISK_LABEL, RISK_RULE, type Cuisine, type Daypart, type Inputs, type RiskAppetite,
  type ServiceFormat, type StorefrontPref,
} from '../types'
import { usd } from '../format'

const CUISINE_SUB: Record<Cuisine, string> = {
  italian: 'trattoria, pizzeria, pizza delivery',
  steakhouse: 'chophouse, grill',
  fast_food: 'burgers, chicken, counter service',
  asian: 'East, Southeast, South & Central Asian, ramen, fusion',
}
const DAYPARTS: { key: Daypart; label: string }[] = [
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'late_night', label: 'Late night' },
]

function DualRange({ min, max, step, lo, hi, onChange, fmt }: {
  min: number; max: number; step: number; lo: number; hi: number; onChange: (lo: number, hi: number) => void; fmt: (v: number) => string
}) {
  const p = (v: number) => ((v - min) / (max - min)) * 100
  return (
    <div className="dual">
      <div className="dual-values">
        <span>{fmt(lo)}</span>
        <span className="muted">to</span>
        <span>{fmt(hi)}</span>
      </div>
      <div className="dual-track">
        <div className="dual-fill" style={{ left: `${p(lo)}%`, right: `${100 - p(hi)}%` }} />
        <input type="range" min={min} max={max} step={step} value={lo} onChange={(e) => onChange(Math.min(+e.target.value, hi - step), hi)} aria-label="minimum" />
        <input type="range" min={min} max={max} step={step} value={hi} onChange={(e) => onChange(lo, Math.max(+e.target.value, lo + step))} aria-label="maximum" />
      </div>
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button type="button" key={o.key} className={value === o.key ? 'on' : ''} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

type Props = { inputs: Inputs; onChange: (i: Inputs) => void; onSubmit: () => void; busy: boolean }

export default function Intake({ inputs, onChange, onSubmit, busy }: Props) {
  const [draft, setDraft] = useState<string | null>(null)
  const zipText = draft ?? inputs.zip
  const [formatTouched, setFormatTouched] = useState(false)
  const set = (patch: Partial<Inputs>) => onChange({ ...inputs, ...patch })
  const zipInfo = ZIP_BY_CODE.get(zipText.trim())
  const zipError = zipText.length >= 5 && !zipInfo ? 'Not a Chicago ZIP in the study area (60601–60661).' : null

  const setZip = (v: string) => {
    const z = v.replace(/\D/g, '').slice(0, 5)
    if (ZIP_BY_CODE.has(z)) {
      setDraft(null)
      set({ zip: z })
    } else setDraft(z)
  }
  const toggleDaypart = (d: Daypart) => {
    const has = inputs.dayparts.includes(d)
    if (has && inputs.dayparts.length === 1) return
    set({ dayparts: has ? inputs.dayparts.filter((x) => x !== d) : [...inputs.dayparts, d] })
  }

  return (
    <form
      className="intake panel slide-in-left"
      onSubmit={(e) => {
        e.preventDefault()
        if (zipInfo && !busy) onSubmit()
      }}
    >
      <div className="intake-hero">
        <div className="eyebrow">Chicago restaurant site advisor</div>
        <h1>
          Find the block where your restaurant <span className="grad">pays back fastest.</span>
        </h1>
        <p className="muted">
          Enter a budget, a ZIP and a concept. We map every block in the ZIP, build each plan the budget allows and simulate 1,000 futures for each one.
        </p>
      </div>

      <div className="field-row">
        <label className="field zip-field">
          <span className="lbl">ZIP code</span>
          <input value={zipText} onChange={(e) => setZip(e.target.value)} list="chi-zips" inputMode="numeric" placeholder="e.g. 60614" className={zipError ? 'bad' : ''} />
          <datalist id="chi-zips">
            {ZIPS.map((z) => (
              <option key={z.zip} value={z.zip}>{z.name}</option>
            ))}
          </datalist>
          <span className={`hint ${zipError ? 'err' : ''}`}>{zipError ?? zipInfo?.name ?? 'Chicago ZIPs 60601–60661'}</span>
        </label>
        <label className="field">
          <span className="lbl">Liquor license</span>
          <button type="button" className={`toggle ${inputs.liquor ? 'on' : ''}`} onClick={() => set({ liquor: !inputs.liquor })}>
            <i />
            <span>{inputs.liquor ? 'Needed' : 'Not needed'}</span>
          </button>
          <span className="hint">{inputs.liquor ? 'Moratorium blocks are excluded' : 'No liquor constraint'}</span>
        </label>
      </div>

      <div className="field">
        <span className="lbl">Total startup budget <em>incl. working-capital reserve</em></span>
        <DualRange min={100_000} max={1_500_000} step={10_000} lo={inputs.budgetMin} hi={inputs.budgetMax} fmt={usd} onChange={(lo, hi) => set({ budgetMin: lo, budgetMax: hi })} />
      </div>

      <div className="field">
        <span className="lbl">Concept</span>
        <div className="cuisines">
          {CUISINES.map((c) => (
            <button
              type="button"
              key={c}
              className={`cuisine ${inputs.cuisine === c ? 'on' : ''}`}
              onClick={() => set({ cuisine: c, format: formatTouched ? inputs.format : DEFAULT_FORMAT[c] })}
            >
              <b>{CUISINE_LABEL[c]}</b>
              <span>{CUISINE_SUB[c]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="lbl">Service format {!formatTouched && <em>default for this concept</em>}</span>
        <Seg<ServiceFormat>
          value={inputs.format}
          options={(['quick_service', 'fast_casual', 'full_service'] as ServiceFormat[]).map((k) => ({ key: k, label: FORMAT_LABEL[k] }))}
          onChange={(v) => {
            setFormatTouched(true)
            set({ format: v })
          }}
        />
      </div>

      <div className="field">
        <span className="lbl">Floor area</span>
        <DualRange min={800} max={5000} step={50} lo={inputs.sqftMin} hi={inputs.sqftMax} fmt={(v) => `${v.toLocaleString('en-US')} sq ft`} onChange={(lo, hi) => set({ sqftMin: lo, sqftMax: hi })} />
      </div>

      <div className="field">
        <span className="lbl">Storefront type</span>
        <Seg<StorefrontPref>
          value={inputs.storefront}
          options={[
            { key: 'both', label: 'Compare both' },
            { key: 'vacant', label: 'Vacant shell' },
            { key: 'second_gen', label: 'Second-gen' },
          ]}
          onChange={(v) => set({ storefront: v })}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <span className="lbl">Dayparts</span>
          <div className="chips">
            {DAYPARTS.map((d) => (
              <button type="button" key={d.key} className={`chip ${inputs.dayparts.includes(d.key) ? 'on' : ''}`} onClick={() => toggleDaypart(d.key)}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="lbl">Risk appetite</span>
          <Seg<RiskAppetite>
            value={inputs.risk}
            options={(['conservative', 'balanced', 'aggressive'] as RiskAppetite[]).map((k) => ({ key: k, label: RISK_LABEL[k] }))}
            onChange={(v) => set({ risk: v })}
          />
          <span className="hint">Ranks plans by {RISK_RULE[inputs.risk]}</span>
        </div>
      </div>

      <button type="submit" className="cta" disabled={!zipInfo || busy}>
        <span>{busy ? 'Analyzing…' : 'Generate site report'}</span>
        <i>→</i>
      </button>
      <div className="sample-note">{SAMPLE_NOTICE}. ZIP boundaries are real (2020 ZCTA).</div>
    </form>
  )
}
