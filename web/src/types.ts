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

/** Optional facts about the operator / site. null or '' = not given: the survival model uses the ZIP average
 *  of recent independent openings for that input. */
export type OperatorInputs = {
  priorLicenses: number | null // Chicago food licenses the operator held before
  entity: boolean | null // registered as a company (LLC, Inc, Corp)
  address: string // street address already in mind, e.g. "2121 N Clark St"
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
  operator: OperatorInputs
}

/** 1,000-day license survival for the ZIP (advantage/survival.py SiteSurvival via /api/survival, or the
 *  exported ZIP default) and P(license still active) by month since opening. */
export type SurvivalInfo = {
  p: number
  pZipDefault: number
  curve: number[] // index = months since opening, 0..72
  inputs: Record<string, { value: number; source: string; raw?: unknown; n_openings?: number }> | null
  addressLookup: { normalized: string; food_licenses_seen: number; ended_last_5y: number; note: string } | null
  source: 'api' | 'zip_default'
  error: string | null // the user's inputs could not be applied (API unreachable)
}

export type CuisineStats = {
  expected: number // restaurants of this type similar areas support (ring-2, ~300 m)
  actual: number // restaurants open (ring-2, Overture)
  opened12m: number // new licenses, last 12 months (Chicago Business Licenses)
  closed12m: number // licenses that ended, last 12 months
  closureRate1000d: number // share of 2018-22 openings nearby whose license did not reach 1,000 days (shrunk)
  historyN: number // openings behind closureRate1000d within ~300 m
  survivalModel1000d: number | null // model: P(new independent keeps license 1,000 days), ZIP level
}

/** One H3 resolution-10 block (~1 city block). Real data from advantage/export_web.py. */
export type Block = {
  h3: string
  lat: number
  lon: number
  zip: string
  commercial: number // 0..1 street-frontage / commercial activity score
  eligible: boolean
  residents: number // ring-2 (LODES RAC scaled to ZIP population)
  jobs: number // ring-2 (LODES WAC)
  highWageShare: number | null // share of employed residents earning > $3,333/month (LODES RAC)
  incomePct: number // 0..100 citywide percentile of highWageShare
  age18to39: number | null // ZIP share aged 18-39
  transitRiders: number // average weekday L entries within ~400 m (CTA)
  restaurants: number // all restaurants, ring-2
  cuisine: Record<Cuisine, CuisineStats>
  rentPsf: number // $/sq ft/yr base rent (ZIP level)
  rentKind: 'live' | 'survey' | 'fallback' // live listings, team survey, or citywide fallback
  liquorMoratorium: boolean // block centre inside a dry precinct (City of Chicago, historical 2011 dataset)
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

/** sourced: every figure read from a cited public source. partial: cited figures plus a stated derivation (note).
 *  unsourced: no public source found; kept as a labelled assumption. */
export type AssumptionStatus = 'sourced' | 'partial' | 'unsourced'

export type Assumption = {
  key: string
  group: string
  label: string
  unit: string
  value: Range3
  source: string
  url?: string
  date: string
  status: AssumptionStatus
  note?: string // how the triangle follows from the cited figures
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
  licensedAtPayback: number // share of draws that pay back before their sampled license end (survival model)
  pnl: PnL // steady state, central values
  staff: StaffLine[]
  rentMonthly: number
  flags: ('over_budget' | 'overrun_risk' | 'budget_headroom' | 'same_address_closures' | 'space_unconfirmed')[]
  feasible: boolean
}

export type PlanDetail = Plan & {
  samples: number[] // payback months per draw (Infinity allowed)
  closures: number[] // per draw: month the license ends, sampled from the survival model's curve (Infinity = beyond horizon)
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
  topOverBudget: boolean // no plan fits the ceiling: top = the plans closest to the budget, simulated in full
  plans: Plan[] // every simulated plan (for the scatter)
  survival: SurvivalInfo
  cheapest: Plan | null
  matrix: { block: Block; label: string; gaps: Record<Cuisine, number> }[]
  zipGaps: Record<Cuisine, number>
}
