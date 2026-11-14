import type { Assumption, Cuisine, Inputs, Range3, ServiceFormat } from '../types'

// Every benchmark below is a PLACEHOLDER until it is replaced by a citable source (design doc §5).
// Only the Chicago wage floor is verified. Values are triangular ranges: [low, most likely, high].
const PENDING = 'Placeholder — benchmark source pending (design doc §5)'
const WAGE_SRC = 'City of Chicago BACP minimum wage, effective 2026-07-01'

const byFormat = <T,>(qs: T, fc: T, fs: T): Record<ServiceFormat, T> => ({ quick_service: qs, fast_casual: fc, full_service: fs })
const scale = (r: Range3, k: number): Range3 => [r[0] * k, r[1] * k, r[2] * k]

const TICKET = byFormat<Range3>([10, 13, 16], [14, 17.5, 22], [28, 38, 50])
const TICKET_MULT: Record<Cuisine, number> = { italian: 1, steakhouse: 1.75, fast_food: 0.92, asian: 1 }
const AUV = byFormat<Range3>([700_000, 950_000, 1_250_000], [800_000, 1_100_000, 1_500_000], [1_000_000, 1_450_000, 2_100_000])
const AUV_MULT: Record<Cuisine, number> = { italian: 1, steakhouse: 1.7, fast_food: 1, asian: 1 }
const FOOD: Record<Cuisine, Range3> = {
  italian: [0.27, 0.3, 0.33], steakhouse: [0.32, 0.36, 0.4], fast_food: [0.28, 0.31, 0.34], asian: [0.26, 0.31, 0.37],
}
const BUILD_VACANT = byFormat<Range3>([130, 175, 240], [150, 200, 270], [180, 240, 320])
const EQUIP = byFormat<Range3>([90_000, 120_000, 160_000], [100_000, 140_000, 190_000], [140_000, 190_000, 260_000])
const GM = byFormat<Range3>([50_000, 56_000, 64_000], [55_000, 62_000, 70_000], [62_000, 72_000, 85_000])
const DELIVERY = byFormat<Range3>([0.15, 0.25, 0.35], [0.12, 0.2, 0.28], [0.04, 0.08, 0.14])
const SQFT_SEAT = byFormat<Range3>([14, 16, 18], [14, 16, 18], [16, 18, 20])
const DINING = byFormat<Range3>([0.5, 0.55, 0.6], [0.5, 0.55, 0.6], [0.55, 0.6, 0.65])
const THROUGHPUT = byFormat<Range3>([0.18, 0.25, 0.32], [0.14, 0.19, 0.24], [0, 0, 0])
const TURNS: Record<Cuisine, Range3> = { italian: [1.4, 2, 2.7], steakhouse: [1, 1.35, 1.8], fast_food: [1.4, 2, 2.7], asian: [1.4, 2, 2.7] }
const LABOR_INTENSITY: Record<Cuisine, Range3> = { italian: [0.95, 1, 1.1], steakhouse: [1.25, 1.4, 1.55], fast_food: [0.9, 1, 1.1], asian: [0.95, 1.05, 1.15] }

type Def = Omit<Assumption, 'edited'>
const a = (key: string, group: string, label: string, unit: string, value: Range3, source = PENDING, date = '—', verified = false): Def => ({
  key, group, label, unit, value, source, date, verified,
})

export function buildAssumptions(inputs: Inputs): Assumption[] {
  const { cuisine, format, liquor } = inputs
  const steakFs = cuisine === 'steakhouse' && format === 'full_service' ? 1.15 : 1
  const list: Def[] = [
    a('ticket', 'Revenue', 'Average check per guest', '$', scale(TICKET[format], TICKET_MULT[cuisine])),
    a('auv', 'Revenue', 'Unit revenue benchmark (AUV)', '$/yr', scale(AUV[format], format === 'full_service' ? AUV_MULT[cuisine] : 1)),
    a('demand_adj', 'Revenue', 'Demand adjustment bounds (min · neutral · max)', '×', [0.6, 1, 1.4]),
    a('covers_var', 'Revenue', 'Guest traffic uncertainty', '×', [0.8, 1, 1.15]),
    a('ramp_start', 'Revenue', 'Month-1 revenue vs steady state', '%', [0.55, 0.65, 0.75]),
    a('ramp_months', 'Revenue', 'Months to reach steady state', 'mo', [5, 7, 10]),
    ...(format === 'full_service'
      ? [a('turns', 'Capacity', 'Table turns per day (lunch + dinner)', '×', TURNS[cuisine]), a('occupancy', 'Capacity', 'Seat occupancy per turn', '%', [0.55, 0.68, 0.8])]
      : [a('throughput', 'Capacity', 'Peak-limited guests per sq ft per day', 'guests', THROUGHPUT[format])]),
    a('sqft_seat', 'Capacity', 'Dining area per seat', 'sq ft', SQFT_SEAT[format]),
    a('dining_share', 'Capacity', 'Dining share of floor area', '%', DINING[format]),
    a('food_cost', 'Operating', 'Food & beverage cost', '% rev', FOOD[cuisine]),
    a('utilities', 'Operating', 'Utilities (gas, power, water)', '% rev', [0.03, 0.035, 0.045]),
    a('marketing', 'Operating', 'Marketing', '% rev', [0.02, 0.03, 0.04]),
    a('card_fees', 'Operating', 'Card processing (non-delivery sales)', '% rev', [0.027, 0.029, 0.031]),
    a('delivery_share', 'Operating', 'Delivery share of sales', '%', DELIVERY[format]),
    a('delivery_fee', 'Operating', 'Delivery platform commission', '%', [0.15, 0.22, 0.3]),
    a('repairs', 'Operating', 'Repairs & maintenance', '% rev', [0.01, 0.015, 0.02]),
    a('other_opex', 'Operating', 'Supplies, smallwares, POS, accounting, misc.', '% rev', [0.03, 0.045, 0.06]),
    a('insurance', 'Operating', 'Insurance', '$/mo', [900, 1200, 1700]),
    a('rent_var', 'Occupancy', 'Rent vs model estimate', '×', [0.85, 1, 1.2]),
    a('nnn', 'Occupancy', 'NNN pass-through (tax, insurance, CAM)', '$/sq ft/yr', [7, 9, 12]),
    a('deposit_months', 'Occupancy', 'Security deposit', 'months rent', [2, 2.5, 3]),
    a('min_wage', 'Labor', 'Chicago minimum wage', '$/hr', [17.05, 17.05, 17.05], WAGE_SRC, '2026-07-01', true),
    a('tipped_wage', 'Labor', 'Chicago tipped minimum wage', '$/hr', [12.96, 12.96, 12.96], WAGE_SRC, '2026-07-01', true),
    a('cook_wage', 'Labor', 'Line cook wage', '$/hr', [18.5, 20.5, 23]),
    a('lead_wage', 'Labor', 'Shift lead wage', '$/hr', [18, 19.5, 21.5]),
    a('gm_salary', 'Labor', 'General manager salary', '$/yr', GM[format]),
    ...(format === 'full_service' ? [a('km_salary', 'Labor', 'Kitchen manager salary', '$/yr', [52_000, 58_000, 66_000])] : []),
    a('labor_intensity', 'Labor', 'Staffing intensity vs. format template', '×', LABOR_INTENSITY[cuisine]),
    a('payroll_tax', 'Labor', 'Employer payroll taxes & benefits', '% wages', [0.12, 0.15, 0.18]),
    a('build_vacant', 'Startup', 'Full build-out, vacant shell (hood, grease trap, plumbing, ADA)', '$/sq ft', scale(BUILD_VACANT[format], steakFs)),
    a('build_second', 'Startup', 'Refresh build-out, second-gen space', '$/sq ft', [45, 75, 120]),
    a('equipment', 'Startup', 'Kitchen & FOH equipment (at 2,000 sq ft)', '$', EQUIP[format]),
    a('equip_repair', 'Startup', 'Second-gen: equipment repair & top-up', '% of new', [0.15, 0.25, 0.4]),
    a('key_money', 'Startup', 'Second-gen: key money / equipment buy-out', '$', [20_000, 45_000, 90_000]),
    a('licenses', 'Startup', 'Licenses & permits', '$', [8_000, 12_000, 18_000]),
    ...(liquor ? [a('liquor_license', 'Startup', 'Liquor license & related fees', '$', [6_000, 10_000, 16_000])] : []),
    a('preopening', 'Startup', 'Pre-opening: hiring, training, launch', '$', [15_000, 25_000, 40_000]),
    a('prep_vacant', 'Startup', 'Months of rent before opening, vacant shell', 'mo', [4, 5, 7]),
    a('prep_second', 'Startup', 'Months of rent before opening, second-gen', 'mo', [1.5, 2, 3]),
    a('reserve_months', 'Startup', 'Working-capital reserve (rent, NNN, salaried mgmt, insurance)', 'mo', [3, 3, 3]),
  ]
  return list
}

export type Params = Record<string, Range3>

export function toParams(list: Assumption[]): Params {
  return Object.fromEntries(list.map((x) => [x.key, x.value]))
}

export const DAYPART_SHARE = byFormat(
  { lunch: 0.5, dinner: 0.45, late_night: 0.12 },
  { lunch: 0.5, dinner: 0.45, late_night: 0.12 },
  { lunch: 0.3, dinner: 0.7, late_night: 0.1 },
)
export const DAYPART_HOURS = { lunch: 5, dinner: 6, late_night: 3 }
