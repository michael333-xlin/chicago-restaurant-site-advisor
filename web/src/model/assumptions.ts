import type { Assumption, AssumptionStatus, Cuisine, Inputs, Range3, ServiceFormat } from '../types'
import BENCH from './benchmarks.json'

// Every benchmark comes from model/benchmarks.json: cited public sources (publisher, URL, date, the figure read on the
// page) and the derivation of each [low, most likely, high] triangle. Parameters with no public source keep a value
// and are labelled 'unsourced' in the assumptions table. Only the Chicago wage floor is set here directly.
type Bench = {
  by: 'format' | 'cuisine' | 'none'
  values: Record<string, Range3>
  status: AssumptionStatus
  status_by?: Record<string, AssumptionStatus>
  source: string
  url: string | null
  date: string
  note: string
}
const B = BENCH as unknown as Record<string, Bench>
const WAGE_SRC = 'City of Chicago BACP minimum wage, effective 2026-07-01'

type Def = Omit<Assumption, 'edited'>

/** Triangle + provenance of a benchmark for this concept (format- or cuisine-specific where the source is). */
function bench(key: string, fmt: ServiceFormat, cuisine: Cuisine) {
  const b = B[key]
  if (!b) throw new Error(`benchmark ${key} missing from benchmarks.json`)
  const k = b.by === 'format' ? (b.values[`${cuisine}_${fmt}`] ? `${cuisine}_${fmt}` : fmt) : b.by === 'cuisine' ? cuisine : 'all'
  const value = b.values[k]
  if (!value) throw new Error(`benchmark ${key} has no value for ${k}`)
  const status = b.status_by?.[k] ?? b.status
  // pages cited for an unsourced value were only cross-checks: show them in the note, not as the source
  if (status === 'unsourced') return { value: [...value] as Range3, source: 'No public source (hover for note)', date: '—', status, note: b.note }
  return { value: [...value] as Range3, source: b.source, url: b.url ?? undefined, date: b.date, status, note: b.note }
}

export function buildAssumptions(inputs: Inputs): Assumption[] {
  const { cuisine, format, liquor } = inputs
  const a = (key: string, group: string, label: string, unit: string): Def => ({ key, group, label, unit, ...bench(key, format, cuisine) })
  const list: Def[] = [
    a('ticket', 'Revenue', 'Average check per guest', '$'),
    a('auv', 'Revenue', 'Unit revenue benchmark (AUV)', '$/yr'),
    {
      key: 'demand_adj', group: 'Revenue', label: 'Demand adjustment bounds (min · neutral · max)', unit: '×', value: [0.6, 1, 1.4],
      source: 'Model assumption', date: '—', status: 'unsourced',
      note: 'Bounds on how far the supply-gap ratio (expected + 1) / (actual + 1) from the gap model moves demand. No revenue data exists to estimate this mapping, so the bounds are an unvalidated assumption.',
    },
    a('covers_var', 'Revenue', 'Guest traffic uncertainty', '×'),
    a('ramp_start', 'Revenue', 'Month-1 revenue vs steady state', '%'),
    a('ramp_months', 'Revenue', 'Months to reach steady state', 'mo'),
    ...(format === 'full_service'
      ? [a('turns', 'Capacity', 'Table turns per day (lunch + dinner)', '×'), a('occupancy', 'Capacity', 'Seat occupancy per turn', '%')]
      : [a('throughput', 'Capacity', 'Peak-limited guests per sq ft per day', 'guests')]),
    a('sqft_seat', 'Capacity', 'Dining area per seat', 'sq ft'),
    a('dining_share', 'Capacity', 'Dining share of floor area', '%'),
    a('food_cost', 'Operating', 'Food & beverage cost', '% rev'),
    a('utilities', 'Operating', 'Utilities (gas, power, water)', '% rev'),
    a('marketing', 'Operating', 'Marketing', '% rev'),
    a('card_fees', 'Operating', 'Card processing (non-delivery sales)', '% rev'),
    a('delivery_share', 'Operating', 'Delivery share of sales', '%'),
    a('delivery_fee', 'Operating', 'Delivery platform commission', '%'),
    a('repairs', 'Operating', 'Repairs & maintenance', '% rev'),
    a('other_opex', 'Operating', 'Supplies, smallwares, POS, accounting, misc.', '% rev'),
    a('insurance', 'Operating', 'Insurance', '$/mo'),
    a('rent_var', 'Occupancy', 'Rent vs model estimate', '×'),
    a('nnn', 'Occupancy', 'NNN pass-through (tax, insurance, CAM)', '$/sq ft/yr'),
    a('deposit_months', 'Occupancy', 'Security deposit', 'months rent'),
    { key: 'min_wage', group: 'Labor', label: 'Chicago minimum wage', unit: '$/hr', value: [17.05, 17.05, 17.05], source: WAGE_SRC, date: '2026-07-01', status: 'sourced' },
    { key: 'tipped_wage', group: 'Labor', label: 'Chicago tipped minimum wage', unit: '$/hr', value: [12.96, 12.96, 12.96], source: WAGE_SRC, date: '2026-07-01', status: 'sourced' },
    a('cook_wage', 'Labor', 'Line cook wage', '$/hr'),
    a('lead_wage', 'Labor', 'Shift lead wage', '$/hr'),
    a('gm_salary', 'Labor', 'General manager salary', '$/yr'),
    ...(format === 'full_service' ? [a('km_salary', 'Labor', 'Kitchen manager salary', '$/yr')] : []),
    a('labor_intensity', 'Labor', 'Staffing intensity vs. format template', '×'),
    a('payroll_tax', 'Labor', 'Employer payroll taxes & benefits', '% wages'),
    a('build_vacant', 'Startup', 'Full build-out, vacant shell (hood, grease trap, plumbing, ADA)', '$/sq ft'),
    a('build_second', 'Startup', 'Refresh build-out, second-gen space', '$/sq ft'),
    a('equipment', 'Startup', 'Kitchen & FOH equipment (at 2,000 sq ft)', '$'),
    a('equip_repair', 'Startup', 'Second-gen: equipment repair & top-up', '% of new'),
    a('key_money', 'Startup', 'Second-gen: key money / equipment buy-out', '$'),
    a('licenses', 'Startup', 'Licenses & permits', '$'),
    ...(liquor ? [a('liquor_license', 'Startup', 'Liquor license & related fees', '$')] : []),
    a('preopening', 'Startup', 'Pre-opening: hiring, training, launch', '$'),
    a('prep_vacant', 'Startup', 'Months of rent before opening, vacant shell', 'mo'),
    a('prep_second', 'Startup', 'Months of rent before opening, second-gen', 'mo'),
    a('reserve_months', 'Startup', 'Working-capital reserve (rent, NNN, salaried mgmt, insurance)', 'mo'),
  ]
  return list
}

export type Params = Record<string, Range3>

export function toParams(list: Assumption[]): Params {
  return Object.fromEntries(list.map((x) => [x.key, x.value]))
}

const byFormat = <T,>(qs: T, fc: T, fs: T): Record<ServiceFormat, T> => ({ quick_service: qs, fast_casual: fc, full_service: fs })

export const DAYPART_SHARE = byFormat(
  { lunch: 0.5, dinner: 0.45, late_night: 0.12 },
  { lunch: 0.5, dinner: 0.45, late_night: 0.12 },
  { lunch: 0.3, dinner: 0.7, late_night: 0.1 },
)
export const DAYPART_HOURS = { lunch: 5, dinner: 6, late_night: 3 }
