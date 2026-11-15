// Real Chicago block data, exported by advantage/export_web.py and served at /data/ (see README).
// Replaces the former synthetic generator (sample.ts). ZIP boundaries are 2020 ZCTA.
import type { Block, Cuisine, OperatorInputs, SurvivalInfo, ZipInfo } from '../types'
import { streetLabel } from './chicagoGrid'
import { ZIP_NAMES } from './zipNames'
import rawZips from './chicago_zips.json'

const env = import.meta.env as Record<string, string | undefined>
export const DATA_BASE = (env.VITE_DATA_BASE ?? '/data').replace(/\/$/, '')
export const API_BASE = (env.VITE_API_BASE ?? '/api').replace(/\/$/, '')

type RawZip = { zip: string; center: [number, number]; bbox: [number, number, number, number]; polygons: [number, number][][] }
export const ZIPS: ZipInfo[] = (rawZips as RawZip[]).map((z) => ({ ...z, name: ZIP_NAMES[z.zip] ?? 'Chicago' }))
export const ZIP_BY_CODE = new Map(ZIPS.map((z) => [z.zip, z]))

export type RentInfo = { psf: number; kind: 'live' | 'survey' | 'fallback'; source: string; urls: string[]; n?: number }
export type Meta = {
  generatedAt: string
  asOf: string
  snapshotId: string | null
  modelVersion: string | null
  notice: string
  gapReliability: Record<Cuisine, number>
  rentByZip: Record<string, RentInfo>
  liveCounts: Record<string, { n: number; latest_ingested: string | null }>
  ctaWindow: string[]
  licenseCurve: { S: number[]; S1000d: number; check: Record<string, { pred_mean: number; obs_mean: number; quintile_abs_err: number; auc: number }> }
  survivalModel: { kind: string; featureSet: string; aucIndependent: number; aucAll: number; brier: number; brierConstant: number }
  sources: Record<string, string>
}
export type EvidenceItem = { title?: string; source_url: string; published_date?: string; observed_date?: string; event_date?: string; kind?: string; summary?: string; rent_psf_year?: number; avg_ticket_usd?: number; name?: string; status?: string }
export type Evidence = { rents: EvidenceItem[]; prices: EvidenceItem[]; places: EvidenceItem[]; signals: EvidenceItem[]; rent: RentInfo | null }

type RawBlock = Omit<Block, 'street'>
type OverviewCell = { h3: string; zip: string; block: Block }

let meta: Meta | null = null
let overview: OverviewCell[] | null = null
const zipCache = new Map<string, Block[]>()

const withStreet = (b: RawBlock): Block => ({ ...b, street: streetLabel(b.lat, b.lon) })

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${DATA_BASE}/${path}`)
  if (r.status === 503) throw new Error('The server is preparing the Chicago data (first start takes ~5 minutes).')
  if (!r.ok) throw new Error(`Data file ${path} is not available (HTTP ${r.status}). Run the data export — see README.`)
  return (await r.json()) as T
}

/** Meta + citywide overview cells. Call once before rendering the map. */
export async function loadBase(): Promise<void> {
  if (overview && meta) return
  const [m, o] = await Promise.all([getJson<Meta>('meta.json'), getJson<{ h3: string; zip: string; block: RawBlock }[]>('overview.json')])
  meta = m
  overview = o.map((x) => ({ h3: x.h3, zip: x.zip, block: withStreet(x.block) }))
}

/** Every H3 res-10 block inside a ZIP (fetched once, then cached). */
export async function loadZip(zip: string): Promise<Block[]> {
  const hit = zipCache.get(zip)
  if (hit) return hit
  const raw = await getJson<RawBlock[]>(`blocks/${zip}.json`)
  const blocks = raw.map(withStreet)
  zipCache.set(zip, blocks)
  return blocks
}

/** Drop cached data so the next load picks up a fresh export (after live data was ingested). */
export function invalidate(zip?: string) {
  if (zip) zipCache.delete(zip)
  else zipCache.clear()
}

export function overviewCells(): OverviewCell[] {
  if (!overview) throw new Error('Block data not loaded yet')
  return overview
}

/** Citywide reference blocks (one per res-8 cell) for percentiles and normalisation. */
export function referenceBlocks(): Block[] {
  return overviewCells().map((o) => o.block)
}

export function zipBlocks(zip: string): Block[] {
  return zipCache.get(zip) ?? []
}

export function dataMeta(): Meta | null {
  return meta
}

export function dataNotice(): string {
  return meta ? `${meta.notice}${meta.modelVersion ? ` · model ${meta.modelVersion.split('_')[0]}` : ''}` : 'Loading Chicago data…'
}

export function rentInfo(zip: string): RentInfo | null {
  return meta?.rentByZip[zip] ?? null
}

/** Live evidence for a ZIP: API first (always fresh), static export as fallback. */
export async function loadEvidence(zip: string): Promise<Evidence | null> {
  for (const url of [`${API_BASE}/evidence/${zip}`, `${DATA_BASE}/evidence/${zip}.json`]) {
    try {
      const r = await fetch(url)
      if (r.ok) return (await r.json()) as Evidence
    } catch {
      /* try the next source */
    }
  }
  return null
}

export function percentile(sorted: number[], v: number) {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < v) lo = mid + 1
    else hi = mid
  }
  return (100 * lo) / Math.max(1, sorted.length)
}

/** P(license still active) by month for a site whose 1,000-day estimate is p: proportional hazards on the citywide
 *  license-duration curve (same formula as advantage/survival.py site_curve). */
export function siteCurve(p: number): number[] {
  if (!meta) throw new Error('Block data not loaded yet')
  const { S, S1000d } = meta.licenseCurve
  const k = Math.log(Math.min(Math.max(p, 1e-4), 1 - 1e-4)) / Math.log(S1000d)
  return S.map((s) => Math.pow(s, k))
}

export const hasOperatorInputs = (o: OperatorInputs) => o.priorLicenses != null || o.entity != null || o.address.trim() !== ''

/** Survival for the ZIP. Without operator inputs: the exported ZIP default (same model, ZIP averages). With inputs:
 *  /api/survival re-scores the model; if it cannot be reached the default is used and the error is reported. */
export async function loadSurvival(zip: string, cuisine: Cuisine, op: OperatorInputs, blocks: Block[]): Promise<SurvivalInfo> {
  const withP = blocks.find((b) => b.cuisine[cuisine].survivalModel1000d != null)
  const p0 = withP?.cuisine[cuisine].survivalModel1000d
  if (p0 == null) throw new Error(`No survival estimate for ZIP ${zip} (fewer than 30 restaurants).`)
  const fallback = (error: string | null): SurvivalInfo => ({ p: p0, pZipDefault: p0, curve: siteCurve(p0), inputs: null, addressLookup: null, source: 'zip_default', error })
  if (!hasOperatorInputs(op)) return fallback(null)
  const q = new URLSearchParams({ zip5: zip, cuisine })
  if (op.priorLicenses != null) q.set('prior_licenses', String(op.priorLicenses))
  if (op.entity != null) q.set('entity', String(op.entity))
  if (op.address.trim()) q.set('address', op.address.trim())
  try {
    const r = await fetch(`${API_BASE}/survival?${q}`)
    if (!r.ok) return fallback(`survival API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    return { p: j.p_license_1000d, pZipDefault: j.p_license_1000d_zip_default, curve: j.license_curve, inputs: j.inputs, addressLookup: j.address_lookup, source: 'api', error: null }
  } catch (e) {
    return fallback(`survival API unreachable (${(e as Error).message})`)
  }
}
