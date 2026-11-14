// Deterministic financial model (design doc §6.5). Same inputs + same seed => same outputs.
import type { Block, Inputs, PnL, StaffLine, StartupBreakdown, StorefrontType } from '../types'
import { DAYPART_HOURS, DAYPART_SHARE, type Params } from './assumptions'

export type Draw = Record<string, number>
export type Mods = { ticket?: number; covers?: number; rent?: number; food?: number }

export function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Inverse CDF of a triangular distribution. */
function tri([lo, mode, hi]: [number, number, number], u: number) {
  if (hi <= lo) return mode
  const f = (mode - lo) / (hi - lo)
  return u < f ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode))
}

export const centralDraw = (p: Params): Draw => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v[1]]))
export const sampleDraw = (p: Params, rnd: () => number): Draw =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, tri(v, rnd())]))

const HOURS_PER_FTE = (40 * 52) / 12
const DAYS = 30.4
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export type Economics = {
  seats: number
  ticket: number
  coversPerDay: number
  capacityBound: boolean
  revenue: number // steady-state monthly
  varPct: number
  fixed: number // monthly labor + rent + insurance
  rentMonthly: number
  staff: StaffLine[]
  labor: number
  startup: StartupBreakdown
  pnl: PnL
  rampStart: number
  rampMonths: number
}

export function centralTicket(block: Block, p: Params) {
  return p.ticket[1] * (0.9 + (0.2 * block.incomePct) / 100)
}

export function economics(block: Block, inputs: Inputs, p: Params, d: Draw, sqft: number, type: StorefrontType, mods: Mods = {}): Economics {
  const fmt = inputs.format
  const share = DAYPART_SHARE[fmt]
  const dp = inputs.dayparts.reduce((s, x) => s + share[x], 0) / (share.lunch + share.dinner)
  const hf = (1 + inputs.dayparts.reduce((s, x) => s + DAYPART_HOURS[x], 0)) / 12
  const spend = 0.9 + (0.2 * block.incomePct) / 100
  const ticket = d.ticket * spend * (mods.ticket ?? 1)

  const cs = block.cuisine[inputs.cuisine]
  const adj = clamp((cs.expected + 1) / (cs.actual + 1), p.demand_adj[0], p.demand_adj[2])
  const demand = (d.auv / centralTicket(block, p) / 360) * adj * dp * d.covers_var
  const seats = Math.floor((sqft * d.dining_share) / d.sqft_seat)
  const capacity = fmt === 'full_service' ? seats * d.turns * d.occupancy * dp : sqft * d.throughput * dp
  const coversPerDay = Math.min(capacity, demand) * (mods.covers ?? 1)
  const revenue = coversPerDay * ticket * DAYS

  // Staffing template (FTE scale with steady-state covers and opening hours).
  const staff: StaffLine[] = []
  const li = d.labor_intensity
  const hourly = (role: string, fte: number, wage: number, tipped = false) =>
    staff.push({ role, fte: fte * li, wage, tipped, salaried: false, monthly: fte * li * wage * HOURS_PER_FTE })
  const salaried = (role: string, salary: number) => staff.push({ role, fte: 1, wage: salary, tipped: false, salaried: true, monthly: salary / 12 })
  const c = coversPerDay
  salaried('General manager', d.gm_salary)
  if (fmt === 'full_service') {
    salaried('Kitchen manager', d.km_salary)
    hourly('Line cooks', Math.max(1.5, c / 40) * hf, d.cook_wage)
    hourly('Prep & dish', Math.max(1, c / 80) * hf, d.min_wage)
    hourly('Servers', Math.max(1.5, c / 35) * hf, d.tipped_wage, true)
    if (c > 100) hourly('Bussers', Math.max(1, c / 100) * hf, d.tipped_wage, true)
    if (c > 120) hourly('Host', hf, d.min_wage)
    if (inputs.liquor) hourly('Bartender', hf, d.tipped_wage, true)
  } else if (fmt === 'fast_casual') {
    hourly('Shift leads', 1.5 * hf, d.lead_wage)
    hourly('Crew', Math.max(2, c / 60) * hf, d.min_wage)
    hourly('Prep & dish', hf, d.min_wage)
    if (inputs.liquor) hourly('Bar / beverage', 0.5 * hf, d.tipped_wage, true)
  } else {
    hourly('Shift leads', 1.5 * hf, d.lead_wage)
    hourly('Crew', Math.max(2, c / 70) * hf, d.min_wage)
  }
  const wages = staff.reduce((s, x) => s + x.monthly, 0)
  const labor = wages * (1 + d.payroll_tax)
  const salariedMonthly = staff.filter((x) => x.salaried).reduce((s, x) => s + x.monthly, 0) * (1 + d.payroll_tax)

  const rentMonthly = (sqft * (block.rentPsf * d.rent_var + d.nnn) * (mods.rent ?? 1)) / 12
  const food = d.food_cost * (mods.food ?? 1)
  const delivery = d.delivery_share
  const varParts = [
    { label: 'Utilities', pct: d.utilities },
    { label: 'Marketing', pct: d.marketing },
    { label: 'Card fees', pct: d.card_fees * (1 - delivery) },
    { label: 'Delivery commission', pct: delivery * d.delivery_fee },
    { label: 'Repairs', pct: d.repairs },
    { label: 'Supplies & misc.', pct: d.other_opex },
  ]
  const otherVar = varParts.reduce((s, x) => s + x.pct, 0)
  const varPct = food + otherVar
  const fixed = labor + rentMonthly + d.insurance

  const eqNew = d.equipment * Math.sqrt(sqft / 2000)
  const vacant = type === 'vacant'
  const prep = vacant ? d.prep_vacant : d.prep_second
  const startup: StartupBreakdown = {
    buildout: sqft * (vacant ? d.build_vacant : d.build_second),
    equipment: vacant ? eqNew : eqNew * d.equip_repair,
    keyMoney: vacant ? 0 : d.key_money,
    deposit: d.deposit_months * rentMonthly,
    licenses: d.licenses + (inputs.liquor ? d.liquor_license : 0),
    preOpening: d.preopening + prep * rentMonthly,
    reserve: d.reserve_months * (rentMonthly + salariedMonthly + d.insurance),
    total: 0,
  }
  startup.total = startup.buildout + startup.equipment + startup.keyMoney + startup.deposit + startup.licenses + startup.preOpening + startup.reserve

  const other = revenue * otherVar + d.insurance
  const pnl: PnL = {
    revenue,
    food: revenue * food,
    labor,
    rent: rentMonthly,
    other,
    net: revenue * (1 - varPct) - fixed,
    detail: [...varParts.map((x) => ({ label: x.label, value: revenue * x.pct })), { label: 'Insurance', value: d.insurance }],
  }
  return {
    seats, ticket, coversPerDay, capacityBound: capacity < demand, revenue, varPct, fixed, rentMonthly, staff, labor, startup, pnl,
    rampStart: d.ramp_start, rampMonths: d.ramp_months,
  }
}

const ramp = (m: number, r0: number, T: number) => (m >= T ? 1 : r0 + ((1 - r0) * (m - 1)) / Math.max(1, T - 1))

/** Months from opening until cumulative net cash flow covers the startup cost (fractional). */
export function payback(e: Economics, horizon: number, path?: Float32Array) {
  let cum = 0
  let result = Infinity
  if (path) path[0] = -e.startup.total
  for (let m = 1; m <= horizon; m++) {
    const net = e.revenue * ramp(m, e.rampStart, e.rampMonths) * (1 - e.varPct) - e.fixed
    const prev = cum
    cum += net
    if (path) path[m] = cum - e.startup.total
    if (result === Infinity && cum >= e.startup.total) {
      result = m - 1 + (net > 0 ? (e.startup.total - prev) / net : 1)
      if (!path) break
    }
  }
  return result
}

export function quantile(sorted: ArrayLike<number>, q: number) {
  if (!sorted.length) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  const a = sorted[lo], b = sorted[hi]
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) && i === lo ? a : Infinity
  return a + (b - a) * (i - lo)
}
