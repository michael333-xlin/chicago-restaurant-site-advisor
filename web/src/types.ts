export type Cuisine = 'italian' | 'steakhouse' | 'fast_food' | 'asian'
export type ServiceFormat = 'quick_service' | 'fast_casual' | 'full_service'
export type StorefrontType = 'vacant' | 'second_gen'
export type StorefrontPref = 'both' | StorefrontType
export type Daypart = 'lunch' | 'dinner' | 'late_night'
export type RiskAppetite = 'conservative' | 'balanced' | 'aggressive'

export const CUISINES: Cuisine[] = ['italian', 'steakhouse', 'fast_food', 'asian']

export const CUISINE_LABEL: Record<Cuisine, string> = {
  italian: 'Italian (incl. pizza)',
  steakhouse: 'Steakhouse',
  fast_food: 'Fast food',
  asian: 'Asian (all)',
}
export const CUISINE_SHORT: Record<Cuisine, string> = {
  italian: 'Italian',
  steakhouse: 'Steak',
  fast_food: 'Fast food',
  asian: 'Asian',
}
export const FORMAT_LABEL: Record<ServiceFormat, string> = {
  quick_service: 'Quick service',
  fast_casual: 'Fast casual',
  full_service: 'Full service',
}
export const DEFAULT_FORMAT: Record<Cuisine, ServiceFormat> = {
  italian: 'full_service',
  steakhouse: 'full_service',
  fast_food: 'quick_service',
  asian: 'fast_casual',
}
export const STOREFRONT_LABEL: Record<StorefrontType, string> = {
  vacant: 'Vacant shell',
  second_gen: 'Second-gen restaurant space',
}
export const RISK_LABEL: Record<RiskAppetite, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
}
export const RISK_RULE: Record<RiskAppetite, string> = {
  conservative: 'P90 (conservative-case) payback',
  balanced: 'P50 (base-case) payback',
  aggressive: 'P50 annual profit',
}

export type Inputs = {
  zip: string
  budgetMin: number
  budgetMax: number
  cuisine: Cuisine
  format: ServiceFormat
  sqftMin: number
  sqftMax: number
  storefront: StorefrontPref
  liquor: boolean
  dayparts: Daypart[]
  risk: RiskAppetite
}

export type CuisineStats = {
  expected: number // restaurants the area should support (ring-2, ~300 m)
  actual: number // restaurants open (ring-2)
  opened12m: number
  closed12m: number
  closureRate3y: number
}

/** One H3 resolution-10 block (~1 city block). All values are SAMPLE data. */
export type Block = {
  h3: string
  lat: number
  lon: number
  zip: string
  commercial: number // 0..1 street-frontage / commercial activity score
  eligible: boolean
  residents: number // ring-2
  jobs: number // ring-2
  medianIncome: number
  incomePct: number // 0..100 citywide
  age25to44: number // share
  students: number // share
  hotelRooms: number // ring-2
  transitRiders: number // weekday L boardings within ~400 m
  restaurants: number // all restaurants, ring-2
  cuisine: Record<Cuisine, CuisineStats>
  rentPsf: number // $/sq ft/yr base rent
  liquorMoratorium: boolean
  recentClosures: number // restaurant closures nearby, last 12 months (possible 2nd-gen spaces)
  sameAddressClosures: number
  street: { ns: string; ew: string; label: string; grid: string }
}

export type ZipInfo = {
  zip: string
  name: string
  center: [number, number]
  bbox: [number, number, number, number]
  polygons: [number, number][][]
}

export type Range3 = [number, number, number] // low, mode, high (triangular)

export type Assumption = {
  key: string
  group: string
  label: string
  unit: string
  value: Range3
  source: string
  date: string
  verified: boolean
  edited?: boolean
}

export type StartupBreakdown = {
  buildout: number
  equipment: number
  keyMoney: number
  deposit: number
  licenses: number
  preOpening: number
  reserve: number
  total: number
}

export type PnL = {
  revenue: number
  food: number
  labor: number
  rent: number
  other: number
  net: number
  detail: { label: string; value: number }[]
}

export type StaffLine = { role: string; fte: number; wage: number; tipped: boolean; salaried: boolean; monthly: number }

export type Plan = {
  id: string
  block: Block
  sqft: number
  sizeTier: 'S' | 'M' | 'L'
  storefront: StorefrontType
  secondGenEvidence: string | null
  format: ServiceFormat
  seats: number
  ticket: { low: number; mid: number; high: number }
  coversPerDay: number
  capacityBound: boolean
  startup: { p10: number; p50: number; p90: number; breakdown: StartupBreakdown }
  payback: { p10: number; p50: number; p90: number } // months from opening; Infinity = not within horizon
  annualProfitP50: number
  noPaybackProb: number // share of draws that do not pay back within the horizon
  pnl: PnL // steady state, central values
  staff: StaffLine[]
  rentMonthly: number
  flags: ('overrun_risk' | 'budget_headroom' | 'same_address_closures' | 'space_unconfirmed')[]
  feasible: boolean
}

export type PlanDetail = Plan & {
  samples: number[] // payback months per draw (Infinity allowed)
  startupSamples: number[]
  fan: { p10: number; p50: number; p90: number }[] // cumulative cash position by month (0..horizon)
  sensitivity: { driver: string; low: number; high: number }[] // payback months at -10% / +10%
  basePayback: number
  competition: Competition
  persona: Persona
  alternative: Plan | null // the other storefront type at the same block, if generated
  risks: { level: 'low' | 'medium' | 'high'; text: string }[]
}

export type Competition = {
  score: number
  level: 'Low' | 'Moderate' | 'High' | 'Very high'
  parts: { key: string; label: string; score: number; detail: string }[]
}

export type Persona = {
  headline: string
  tags: { label: string; detail: string }[]
  fit: number
  drivers: { label: string; pct: number }[]
}

export type Report = {
  inputs: Inputs
  zip: ZipInfo
  generatedAt: string
  horizon: number
  draws: number
  stats: {
    blocks: number
    eligible: number
    moratoriumExcluded: number
    screened: number
    simulated: number
    feasible: number
  }
  top: PlanDetail[]
  plans: Plan[] // every simulated plan (for the scatter)
  cheapest: Plan | null
  matrix: { block: Block; label: string; gaps: Record<Cuisine, number> }[]
  zipGaps: Record<Cuisine, number>
}
