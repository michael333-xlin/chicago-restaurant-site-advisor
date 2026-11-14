// Screening, Monte Carlo and budget-constrained ranking (design doc §6.2–6.6).
import { gridDisk } from 'h3-js'
import { percentile, referenceBlocks, ZIP_BY_CODE, zipBlocks } from '../data/sample'
import {
  CUISINE_SHORT, CUISINES, type Assumption, type Block, type Competition, type Cuisine, type Inputs, type Persona, type Plan,
  type PlanDetail, type Report, type StorefrontType,
} from '../types'
import { toParams, type Params } from './assumptions'
import { centralDraw, economics, hashString, mulberry32, payback, quantile, sampleDraw, type Mods } from './finance'

export const HORIZON = 72
export const DRAWS = 1000
const SCREEN_KEEP = 12
const SEPARATION_RINGS = 3

type Candidate = { block: Block; sqft: number; tier: 'S' | 'M' | 'L'; type: StorefrontType; evidence: string | null }

function sizes(inputs: Inputs): { sqft: number; tier: 'S' | 'M' | 'L' }[] {
  const lo = inputs.sqftMin, hi = Math.max(inputs.sqftMax, inputs.sqftMin)
  const mid = Math.round((lo + hi) / 2 / 50) * 50
  const out: { sqft: number; tier: 'S' | 'M' | 'L' }[] = [{ sqft: lo, tier: 'S' }]
  if (mid > lo && mid < hi) out.push({ sqft: mid, tier: 'M' })
  if (hi > lo) out.push({ sqft: hi, tier: 'L' })
  return out
}

function secondGenEvidence(b: Block): string | null {
  return b.recentClosures > 0 ? `${b.recentClosures} restaurant closure${b.recentClosures > 1 ? 's' : ''} within ~300 m in the last 12 months` : null
}

function candidates(block: Block, inputs: Inputs): Candidate[] {
  const evidence = secondGenEvidence(block)
  const types: StorefrontType[] = []
  if (inputs.storefront !== 'second_gen') types.push('vacant')
  if (inputs.storefront !== 'vacant' && evidence) types.push('second_gen')
  return sizes(inputs).flatMap((s) => types.map((type) => ({ block, sqft: s.sqft, tier: s.tier, type, evidence: type === 'second_gen' ? evidence : null })))
}

type Metric = (x: { p50: number; p90: number; profit: number }) => number
const metricFor = (inputs: Inputs): Metric =>
  inputs.risk === 'conservative' ? (x) => x.p90 : inputs.risk === 'balanced' ? (x) => x.p50 : (x) => -x.profit

type Sim = { payback: Float64Array; startup: Float64Array; profit: Float64Array; paths?: Float32Array[] }

function simulate(c: Candidate, inputs: Inputs, p: Params, draws: number, keepPaths: boolean, mods?: Mods): Sim {
  const rnd = mulberry32(hashString(`${c.block.h3}|${c.sqft}|${c.type}|${inputs.cuisine}|${inputs.format}`))
  const out: Sim = { payback: new Float64Array(draws), startup: new Float64Array(draws), profit: new Float64Array(draws), paths: keepPaths ? [] : undefined }
  for (let i = 0; i < draws; i++) {
    const e = economics(c.block, inputs, p, sampleDraw(p, rnd), c.sqft, c.type, mods)
    const path = keepPaths ? new Float32Array(HORIZON + 1) : undefined
    out.payback[i] = payback(e, HORIZON, path)
    out.startup[i] = e.startup.total
    out.profit[i] = e.pnl.net * 12
    if (path) out.paths!.push(path)
  }
  return out
}

const sorted = (a: Float64Array) => Float64Array.from(a).sort()

function toPlan(c: Candidate, inputs: Inputs, p: Params, sim: Sim): Plan {
  const central = economics(c.block, inputs, p, centralDraw(p), c.sqft, c.type)
  const pb = sorted(sim.payback), st = sorted(sim.startup), pr = sorted(sim.profit)
  const startup = { p10: quantile(st, 0.1), p50: quantile(st, 0.5), p90: quantile(st, 0.9), breakdown: central.startup }
  const flags: Plan['flags'] = []
  if (startup.p90 > inputs.budgetMax) flags.push('overrun_risk')
  if (startup.p50 < inputs.budgetMin) flags.push('budget_headroom')
  if (c.type === 'second_gen') {
    flags.push('space_unconfirmed')
    if (c.block.sameAddressClosures >= 2) flags.push('same_address_closures')
  }
  const t = central.ticket
  const r = (v: number) => Math.round(v * 2) / 2
  return {
    id: `${c.block.h3}-${c.tier}-${c.type}`,
    block: c.block,
    sqft: c.sqft,
    sizeTier: c.tier,
    storefront: c.type,
    secondGenEvidence: c.evidence,
    format: inputs.format,
    seats: central.seats,
    ticket: { low: r(t * 0.92), mid: r(t), high: r(t * 1.08) },
    coversPerDay: central.coversPerDay,
    capacityBound: central.capacityBound,
    startup,
    payback: { p10: quantile(pb, 0.1), p50: quantile(pb, 0.5), p90: quantile(pb, 0.9) },
    annualProfitP50: quantile(pr, 0.5),
    noPaybackProb: sim.payback.reduce((s, v) => s + (v > 60 ? 1 : 0), 0) / sim.payback.length,
    pnl: central.pnl,
    staff: central.staff,
    rentMonthly: central.rentMonthly,
    flags,
    feasible: startup.p50 <= inputs.budgetMax,
  }
}

// ---------- competition pressure (§6.2) ----------
let refCache: { cuisine: Cuisine; sat: number[]; dens: number[]; open: number[]; gap: number[] } | null = null
function reference(cuisine: Cuisine) {
  if (refCache?.cuisine === cuisine) return refCache
  const refs = referenceBlocks().filter((b) => b.eligible)
  const s = (f: (b: Block) => number) => refs.map(f).sort((a, b) => a - b)
  refCache = {
    cuisine,
    sat: s((b) => (b.cuisine[cuisine].actual + 0.5) / (b.cuisine[cuisine].expected + 0.5)),
    dens: s((b) => b.restaurants),
    open: s((b) => b.cuisine[cuisine].opened12m),
    gap: s((b) => b.cuisine[cuisine].expected - b.cuisine[cuisine].actual),
  }
  return refCache
}

function competition(b: Block, cuisine: Cuisine): Competition {
  const ref = reference(cuisine)
  const cs = b.cuisine[cuisine]
  const name = CUISINE_SHORT[cuisine]
  const ratio = (cs.actual + 0.5) / (cs.expected + 0.5)
  const gap = cs.expected - cs.actual
  const parts = [
    { key: 'saturation', label: `${name} saturation`, score: percentile(ref.sat, ratio), w: 0.35, detail: `${cs.actual} open vs ${cs.expected.toFixed(1)} expected (×${ratio.toFixed(2)})` },
    { key: 'density', label: 'All-restaurant density', score: percentile(ref.dens, b.restaurants), w: 0.2, detail: `${b.restaurants} restaurants within ~300 m` },
    { key: 'openings', label: `New ${name} openings (12 mo)`, score: percentile(ref.open, cs.opened12m), w: 0.2, detail: `${cs.opened12m} opened in the last 12 months` },
    { key: 'gap', label: 'Demand gap (inverted)', score: 100 - percentile(ref.gap, gap), w: 0.25, detail: `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} restaurants of unmet demand` },
  ]
  const score = Math.round(parts.reduce((s, x) => s + x.score * x.w, 0))
  return {
    score,
    level: score < 35 ? 'Low' : score < 60 ? 'Moderate' : score < 80 ? 'High' : 'Very high',
    parts: parts.map(({ key, label, score, detail }) => ({ key, label, score: Math.round(score), detail })),
  }
}

// ---------- target customers (§6.3) ----------
const DRIVER_W: Record<Cuisine, Partial<Record<'residents' | 'jobs' | 'income' | 'age' | 'students' | 'hotel' | 'transit', number>>> = {
  italian: { residents: 0.3, income: 0.3, jobs: 0.2, age: 0.1, hotel: 0.1 },
  steakhouse: { income: 0.4, jobs: 0.25, hotel: 0.25, residents: 0.1 },
  fast_food: { jobs: 0.3, transit: 0.25, residents: 0.25, students: 0.2 },
  asian: { residents: 0.25, age: 0.25, students: 0.2, jobs: 0.2, transit: 0.1 },
}
const DRIVER_LABEL = { residents: 'Residents nearby', jobs: 'Daytime workers', income: 'Household income', age: 'Share aged 25–44', students: 'College students', hotel: 'Hotel rooms', transit: 'L ridership' }

let personaRef: Record<keyof typeof DRIVER_LABEL, number[]> | null = null
function persona(b: Block, cuisine: Cuisine): Persona {
  if (!personaRef) {
    const refs = referenceBlocks()
    const s = (f: (x: Block) => number) => refs.map(f).sort((a, c) => a - c)
    personaRef = {
      residents: s((x) => x.residents), jobs: s((x) => x.jobs), income: s((x) => x.medianIncome), age: s((x) => x.age25to44),
      students: s((x) => x.students), hotel: s((x) => x.hotelRooms), transit: s((x) => x.transitRiders),
    }
  }
  const val = { residents: b.residents, jobs: b.jobs, income: b.medianIncome, age: b.age25to44, students: b.students, hotel: b.hotelRooms, transit: b.transitRiders }
  const pct = Object.fromEntries(Object.entries(val).map(([k, v]) => [k, percentile(personaRef![k as keyof typeof val], v)])) as Record<keyof typeof val, number>
  const tags: Persona['tags'] = []
  const top = (p: number) => `top ${Math.max(1, Math.round(100 - p))}% citywide`
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
  if (b.jobs > b.residents * 1.5 && pct.jobs >= 70) tags.push({ label: 'Weekday office crowd', detail: `${fmt(b.jobs)} daytime workers vs ${fmt(b.residents)} residents within ~300 m (${top(pct.jobs)})` })
  if (pct.residents >= 70) tags.push({ label: 'Dense residential base', detail: `${fmt(b.residents)} residents within ~300 m (${top(pct.residents)})` })
  if (pct.age >= 65) tags.push({ label: 'Young professionals', detail: `${Math.round(b.age25to44 * 100)}% of residents are 25–44 (${top(pct.age)})` })
  if (pct.income >= 75) tags.push({ label: 'High spending power', detail: `Median household income $${fmt(b.medianIncome)} (${top(pct.income)})` })
  else if (pct.income <= 30) tags.push({ label: 'Value-conscious', detail: `Median household income $${fmt(b.medianIncome)} (bottom ${Math.round(pct.income) + 1}% citywide)` })
  if (b.students >= 0.12) tags.push({ label: 'Student pocket', detail: `${Math.round(b.students * 100)}% of residents enrolled in college` })
  if (b.hotelRooms >= 300) tags.push({ label: 'Visitor traffic', detail: `~${fmt(b.hotelRooms)} hotel rooms within ~300 m` })
  if (pct.transit >= 75) tags.push({ label: 'Transit node', detail: `~${fmt(b.transitRiders)} weekday L boardings within ~400 m (${top(pct.transit)})` })
  if (!tags.length) tags.push({ label: 'Mixed neighborhood', detail: 'No single customer segment stands out against citywide blocks' })
  const w = DRIVER_W[cuisine]
  const fit = Math.round(Object.entries(w).reduce((s, [k, wt]) => s + pct[k as keyof typeof pct] * (wt ?? 0), 0))
  const drivers = (Object.keys(w) as (keyof typeof DRIVER_LABEL)[]).map((k) => ({ label: DRIVER_LABEL[k], pct: Math.round(pct[k]) }))
  const headline = tags.slice(0, 2).map((t) => t.label).join(' + ')
  return { headline, tags, fit, drivers }
}

function risks(plan: Plan, b: Block, cuisine: Cuisine, inputs: Inputs): PlanDetail['risks'] {
  const cs = b.cuisine[cuisine]
  const name = CUISINE_SHORT[cuisine]
  const out: PlanDetail['risks'] = []
  const cr = cs.closureRate3y
  out.push({ level: cr > 0.25 ? 'high' : cr > 0.17 ? 'medium' : 'low', text: `${Math.round(cr * 100)}% of ${name} restaurants nearby closed within 3 years (Food Inspections “Out of Business”)` })
  if (cs.opened12m >= 2) out.push({ level: cs.opened12m >= 4 ? 'high' : 'medium', text: `${cs.opened12m} new ${name} openings within ~300 m in the last 12 months` })
  if (plan.noPaybackProb > 0.1) out.push({ level: plan.noPaybackProb > 0.3 ? 'high' : 'medium', text: `${Math.round(plan.noPaybackProb * 100)}% of simulations do not pay back within 5 years` })
  if (plan.flags.includes('overrun_risk')) out.push({ level: 'medium', text: `Conservative-case startup cost $${Math.round(plan.startup.p90 / 1000)}k exceeds the $${Math.round(inputs.budgetMax / 1000)}k budget ceiling` })
  if (plan.flags.includes('same_address_closures')) out.push({ level: 'high', text: `Likely second-gen address has closed ${b.sameAddressClosures}× before — find out why` })
  if (plan.flags.includes('space_unconfirmed')) out.push({ level: 'medium', text: 'Second-gen space inferred from recent closures; availability not confirmed' })
  if (inputs.liquor) out.push({ level: 'low', text: 'Block is outside liquor-moratorium segments in the sample layer; confirm with BACP before signing' })
  if (plan.capacityBound) out.push({ level: 'low', text: 'Demand exceeds capacity at this size; upside if a larger space is available' })
  return out
}

function detail(c: Candidate, plan: Plan, inputs: Inputs, p: Params, alt: Plan | null): PlanDetail {
  const sim = simulate(c, inputs, p, DRAWS, true)
  const fan = [] as PlanDetail['fan']
  const col = new Float64Array(DRAWS)
  for (let m = 0; m <= HORIZON; m++) {
    for (let i = 0; i < DRAWS; i++) col[i] = sim.paths![i][m]
    col.sort()
    fan.push({ p10: quantile(col, 0.1), p50: quantile(col, 0.5), p90: quantile(col, 0.9) })
  }
  const d = centralDraw(p)
  const pb = (mods: Mods) => payback(economics(c.block, inputs, p, d, c.sqft, c.type, mods), HORIZON)
  const base = pb({})
  const sensitivity = [
    { driver: 'Average check', low: pb({ ticket: 0.9 }), high: pb({ ticket: 1.1 }) },
    { driver: 'Guest traffic', low: pb({ covers: 0.9 }), high: pb({ covers: 1.1 }) },
    { driver: 'Rent', low: pb({ rent: 0.9 }), high: pb({ rent: 1.1 }) },
    { driver: 'Food cost', low: pb({ food: 0.9 }), high: pb({ food: 1.1 }) },
  ]
  return {
    ...plan,
    samples: Array.from(sim.payback),
    startupSamples: Array.from(sim.startup),
    fan,
    sensitivity,
    basePayback: base,
    competition: competition(c.block, inputs.cuisine),
    persona: persona(c.block, inputs.cuisine),
    alternative: alt,
    risks: risks(plan, c.block, inputs.cuisine, inputs),
  }
}

export function runAnalysis(inputs: Inputs, assumptions: Assumption[]): Report {
  const zip = ZIP_BY_CODE.get(inputs.zip)
  if (!zip) throw new Error(`ZIP ${inputs.zip} is not in the Chicago study area.`)
  const p = toParams(assumptions)
  const blocks = zipBlocks(inputs.zip)
  const commercial = blocks.filter((b) => b.eligible)
  const usable = inputs.liquor ? commercial.filter((b) => !b.liquorMoratorium) : commercial
  const metric = metricFor(inputs)
  const central = centralDraw(p)

  // Stage 1: screen every block with central-value assumptions.
  const screened = usable.map((b) => {
    const cands = candidates(b, inputs)
    let best = Infinity
    for (const c of cands) {
      const e = economics(b, inputs, p, central, c.sqft, c.type)
      if (e.startup.total > inputs.budgetMax * 1.15) continue
      const pbm = payback(e, HORIZON)
      best = Math.min(best, metric({ p50: pbm, p90: pbm, profit: e.pnl.net * 12 }))
    }
    return { b, best, n: cands.length }
  })
  const nScreened = screened.reduce((s, x) => s + x.n, 0)
  const blocked = new Set<string>()
  const shortlist: Block[] = []
  for (const s of [...screened].sort((x, y) => x.best - y.best)) {
    if (blocked.has(s.b.h3)) continue
    shortlist.push(s.b)
    for (const h of gridDisk(s.b.h3, SEPARATION_RINGS)) blocked.add(h)
    if (shortlist.length === SCREEN_KEEP) break
  }

  // Stage 2: Monte Carlo on the shortlist.
  const sims: { c: Candidate; plan: Plan }[] = []
  for (const b of shortlist) {
    for (const c of candidates(b, inputs)) sims.push({ c, plan: toPlan(c, inputs, p, simulate(c, inputs, p, DRAWS, false)) })
  }
  const feasible = sims.filter((s) => s.plan.feasible)
  const score = (pl: Plan) => metric({ p50: pl.payback.p50, p90: pl.payback.p90, profit: pl.annualProfitP50 })
  const bestPerBlock = new Map<string, { c: Candidate; plan: Plan }>()
  for (const s of feasible) {
    const cur = bestPerBlock.get(s.c.block.h3)
    if (!cur || score(s.plan) < score(cur.plan) || (score(s.plan) === score(cur.plan) && s.plan.startup.p50 < cur.plan.startup.p50)) bestPerBlock.set(s.c.block.h3, s)
  }
  const ranked = [...bestPerBlock.values()].sort((x, y) => score(x.plan) - score(y.plan) || x.plan.startup.p50 - y.plan.startup.p50).slice(0, 3)
  const top = ranked.map((s) => {
    const alt = sims.find((o) => o.c.block.h3 === s.c.block.h3 && o.c.sqft === s.c.sqft && o.c.type !== s.c.type)?.plan ?? null
    return detail(s.c, s.plan, inputs, p, alt)
  })
  const cheapest = sims.length ? sims.reduce((m, s) => (s.plan.startup.p50 < m.plan.startup.p50 ? s : m)).plan : null

  const matrixBlocks = [...top.map((t) => t.block), ...shortlist.filter((b) => !top.some((t) => t.block.h3 === b.h3))].slice(0, 6)
  const gapOf = (b: Block) => Object.fromEntries(CUISINES.map((c) => [c, b.cuisine[c].expected - b.cuisine[c].actual])) as Record<Cuisine, number>
  const zipGaps = Object.fromEntries(
    CUISINES.map((c) => [c, commercial.reduce((s, b) => s + b.cuisine[c].expected - b.cuisine[c].actual, 0) / Math.max(1, commercial.length)]),
  ) as Record<Cuisine, number>

  return {
    inputs,
    zip,
    generatedAt: new Date().toISOString(),
    horizon: HORIZON,
    draws: DRAWS,
    stats: {
      blocks: blocks.length,
      eligible: commercial.length,
      moratoriumExcluded: commercial.length - usable.length,
      screened: nScreened,
      simulated: sims.length,
      feasible: feasible.length,
    },
    top,
    plans: sims.map((s) => s.plan),
    cheapest,
    matrix: matrixBlocks.map((b) => ({ block: b, label: b.street.label, gaps: gapOf(b) })),
    zipGaps,
  }
}
