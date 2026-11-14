// SAMPLE DATA GENERATOR.
// The Chicago data pipeline (ACS, LODES, Overture, Food Inspections, Assessor) is not built yet.
// Until it is, every block attribute below is synthesized from smooth spatial noise plus
// distance to the Loop and to Chicago's arterial grid. ZIP boundaries are real (2020 ZCTA).
// The shape of each Block matches what the pipeline is expected to return, so this file is
// the single place to swap for real data.
import { cellToCenterChild, cellToLatLng, gridDisk, polygonToCells } from 'h3-js'
import { CUISINES, type Block, type Cuisine, type CuisineStats, type ZipInfo } from '../types'
import { arterialDistance, streetLabel, toGrid } from './chicagoGrid'
import { ZIP_NAMES } from './zipNames'
import rawZips from './chicago_zips.json'

export const SAMPLE_NOTICE = 'Sample data — Chicago data pipeline not yet connected'
export const RES = 10
const RING = 2

type RawZip = { zip: string; center: [number, number]; bbox: [number, number, number, number]; polygons: [number, number][][] }

export const ZIPS: ZipInfo[] = (rawZips as RawZip[]).map((z) => ({ ...z, name: ZIP_NAMES[z.zip] ?? 'Chicago' }))
export const ZIP_BY_CODE = new Map(ZIPS.map((z) => [z.zip, z]))

// ---------- deterministic noise ----------
function hash2(ix: number, iy: number, seed: number) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1013904223)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
const smooth = (t: number) => t * t * (3 - 2 * t)
function vnoise(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const sx = smooth(x - ix), sy = smooth(y - iy)
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed)
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}
const fbm = (x: number, y: number, seed: number) =>
  0.55 * vnoise(x, y, seed) + 0.3 * vnoise(x * 2.1, y * 2.1, seed + 17) + 0.15 * vnoise(x * 4.3, y * 4.3, seed + 31)
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))

// ---------- per-cell base fields ----------
type Base = {
  lat: number; lon: number
  commercial: number; residents: number; jobs: number; incomeIdx: number
  age: number; students: number; hotel: number; transit: number; restaurants: number
  expected: Record<Cuisine, number>; actual: Record<Cuisine, number>
  rent: number; moratorium: boolean; x: number; y: number
}

const CUISINE_SEED: Record<Cuisine, number> = { italian: 101, steakhouse: 202, fast_food: 303, asian: 404 }
const baseCache = new Map<string, Base>()

function base(h: string): Base {
  const hit = baseCache.get(h)
  if (hit) return hit
  const [lat, lon] = cellToLatLng(h)
  const g = toGrid(lat, lon)
  const x = g.ew / 800, y = g.ns / 800 // miles west / north
  const dLoop = Math.hypot(x - 0.2, y - 0.05)
  const a = arterialDistance(g)
  const cNS = Math.exp(-((a.toNS / 0.045) ** 2))
  const cEW = Math.exp(-((a.toEW / 0.045) ** 2))
  const corr = Math.max(cNS, cEW)
  const inter = cNS * cEW
  const downtown = Math.exp(-dLoop / 0.7)
  const character = fbm(x / 0.9, y / 0.9, 3)
  const blockNoise = vnoise(x * 5, y * 5, 11)
  const commercial = clamp(0.08 + 0.62 * corr + 0.25 * inter + 0.7 * downtown + 0.3 * (blockNoise - 0.5) + 0.2 * (character - 0.5))
  const jobs = 2400 * Math.exp(-dLoop / 0.6) + 140 * corr * (0.4 + character) + 260 * inter * vnoise(x * 6, y * 6, 5) + 20
  const residents =
    (40 + 190 * fbm(x / 0.7, y / 0.7, 23)) * (0.3 + 0.7 * (1 - Math.exp(-dLoop / 0.6))) * (0.7 + 0.6 * Math.exp(-(((dLoop - 3) / 2.5) ** 2)))
  const incomeIdx = clamp(0.3 + 0.55 * (fbm(x / 1.3, y / 1.3, 41) - 0.5) * 1.6 + 0.3 * Math.exp(-dLoop / 3.5))
  const age = clamp(0.2 + 0.32 * fbm(x / 0.8, y / 0.8, 7) + 0.1 * Math.exp(-dLoop / 2), 0.12, 0.62)
  const students = 0.02 + 0.3 * clamp((vnoise(x / 0.6, y / 0.6, 9) - 0.6) / 0.4)
  const hotel = 260 * Math.exp(-dLoop / 0.5) + 40 * inter * clamp((vnoise(x * 3, y * 3, 19) - 0.7) / 0.3)
  const transit = 12000 * Math.exp(-dLoop / 0.5) + 7000 * clamp((vnoise(x / 0.45, y / 0.45, 13) - 0.55) / 0.45) * (0.4 + corr)
  const restaurants = (jobs / 260 + residents / 420) * (0.25 + commercial) * (0.7 + 0.6 * vnoise(x * 3, y * 3, 29))

  const cf = 0.25 + commercial
  const expected: Record<Cuisine, number> = {
    italian: (0.0026 * residents * (0.6 + incomeIdx) + 0.0008 * jobs) * cf,
    steakhouse: (0.0005 * jobs * incomeIdx + 0.0004 * hotel + 0.0006 * residents * incomeIdx * incomeIdx) * cf,
    fast_food: (0.0011 * jobs + 0.0018 * residents + 0.00002 * transit + 0.004 * students * residents) * cf,
    asian: (0.0021 * residents * (0.5 + age) + 0.0008 * jobs + 0.006 * students * residents) * cf,
  }
  const actual = {} as Record<Cuisine, number>
  for (const c of CUISINES) {
    const sat = Math.exp(1.1 * (fbm(x / 0.6, y / 0.6, CUISINE_SEED[c]) - 0.5) * 2)
    actual[c] = expected[c] * sat
  }
  const rent = 13 + 52 * Math.exp(-dLoop / 1.3) + 9 * corr + 10 * incomeIdx + 6 * (vnoise(x * 2, y * 2, 37) - 0.5)
  const moratorium = corr > 0.3 && vnoise(x / 0.35, y / 0.35, 21) > 0.8
  const b: Base = { lat, lon, commercial, residents, jobs, incomeIdx, age, students, hotel, transit, restaurants, expected, actual, rent, moratorium, x, y }
  baseCache.set(h, b)
  return b
}

// ---------- block aggregation (ring 2 ≈ 300 m) ----------
const blockCache = new Map<string, Block>()
let reference: { income: number[] } | null = null

function percentile(sorted: number[], v: number) {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < v) lo = mid + 1
    else hi = mid
  }
  return (100 * lo) / Math.max(1, sorted.length)
}

function rawBlock(h: string, zip: string): Omit<Block, 'incomePct'> & { incomePct: number } {
  const b = base(h)
  const ring = gridDisk(h, RING).map(base)
  const sum = (f: (r: Base) => number) => ring.reduce((s, r) => s + f(r), 0)
  const residents = sum((r) => r.residents)
  const incomeIdx = sum((r) => r.incomeIdx * r.residents) / Math.max(1, residents)
  const cuisine = {} as Record<Cuisine, CuisineStats>
  let closures = 0
  for (const c of CUISINES) {
    const expected = sum((r) => r.expected[c])
    const actual = Math.round(sum((r) => r.actual[c]))
    const churn = vnoise(b.x * 2.4, b.y * 2.4, CUISINE_SEED[c] + 7)
    const opened12m = Math.round(actual * (0.04 + 0.16 * churn))
    const closed12m = Math.round(actual * (0.03 + 0.14 * vnoise(b.x * 2.4, b.y * 2.4, CUISINE_SEED[c] + 9)))
    closures += closed12m
    cuisine[c] = { expected, actual, opened12m, closed12m, closureRate3y: 0.1 + 0.22 * churn }
  }
  const otherClosures = Math.round(sum((r) => r.restaurants) * 0.05 * vnoise(b.x * 3, b.y * 3, 53))
  const recentClosures = closures + otherClosures
  return {
    h3: h,
    lat: b.lat,
    lon: b.lon,
    zip,
    commercial: b.commercial,
    eligible: b.commercial >= 0.45,
    residents,
    jobs: sum((r) => r.jobs),
    medianIncome: Math.round((26000 + 175000 * incomeIdx ** 1.3) / 500) * 500,
    incomePct: 0,
    age25to44: sum((r) => r.age * r.residents) / Math.max(1, residents),
    students: sum((r) => r.students * r.residents) / Math.max(1, residents),
    hotelRooms: Math.round(sum((r) => r.hotel)),
    transitRiders: Math.round(b.transit),
    restaurants: Math.round(sum((r) => r.restaurants)),
    cuisine,
    rentPsf: Math.round(b.rent * 2) / 2,
    liquorMoratorium: b.moratorium,
    recentClosures,
    sameAddressClosures: recentClosures > 0 ? Math.floor(vnoise(b.x * 7, b.y * 7, 61) ** 2 * 3.6) : 0,
    street: streetLabel(b.lat, b.lon),
  }
}

/** Citywide reference blocks (one per res-8 cell) for percentiles and normalisation. */
export function referenceBlocks(): Block[] {
  return overviewCells().map((o) => o.block)
}

let overview: { h3: string; zip: string; block: Block }[] | null = null
export function overviewCells() {
  if (overview) return overview
  const cells: { h3: string; zip: string; raw: ReturnType<typeof rawBlock> }[] = []
  for (const z of ZIPS) {
    for (const poly of z.polygons) {
      for (const h8 of polygonToCells(poly.map(([lng, lat]) => [lat, lng]), 8)) {
        cells.push({ h3: h8, zip: z.zip, raw: rawBlock(cellToCenterChild(h8, RES), z.zip) })
      }
    }
  }
  reference = { income: cells.map((c) => c.raw.medianIncome).sort((a, b) => a - b) }
  overview = cells.map((c) => ({ h3: c.h3, zip: c.zip, block: { ...c.raw, incomePct: percentile(reference!.income, c.raw.medianIncome) } }))
  return overview
}

export function block(h: string, zip: string): Block {
  const hit = blockCache.get(h)
  if (hit) return hit
  if (!reference) overviewCells()
  const raw = rawBlock(h, zip)
  const out: Block = { ...raw, incomePct: percentile(reference!.income, raw.medianIncome) }
  blockCache.set(h, out)
  return out
}

/** Every res-10 block inside a ZIP. */
export function zipBlocks(zip: string): Block[] {
  const z = ZIP_BY_CODE.get(zip)
  if (!z) return []
  const seen = new Set<string>()
  const out: Block[] = []
  for (const poly of z.polygons) {
    for (const h of polygonToCells(poly.map(([lng, lat]) => [lat, lng]), RES)) {
      if (seen.has(h)) continue
      seen.add(h)
      out.push(block(h, zip))
    }
  }
  return out
}

export { percentile }
