// The facts the plain-English report may use: one analysis' model outputs and the owner's request.
// Sent to /api/report (advantage/narrative.py). DeepSeek only organizes and explains these; any number in its text
// that is not in this object is flagged by the server's number check.
import { dataMeta } from '../data/blocks'
import {
  CUISINE_LABEL, CUISINE_SHORT, FORMAT_LABEL, RISK_LABEL, RISK_RULE, STOREFRONT_LABEL, type Assumption, type Plan, type Report,
} from '../types'

const usd0 = (v: number) => Math.round(v)
const months = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null) // null = not within the horizon
const share = (v: number) => Math.round(v * 1000) / 1000

function planCore(t: Plan) {
  return {
    name: t.block.street.label,
    grid_location: t.block.street.grid,
    floor_area_sqft: t.sqft,
    storefront: STOREFRONT_LABEL[t.storefront],
    why_second_gen_space: t.secondGenEvidence,
    within_budget: t.feasible,
    flags: t.flags,
    seats: t.seats,
    average_check_usd: t.ticket,
    guests_per_day: Math.round(t.coversPerDay),
    guests_limited_by: t.capacityBound ? 'seats (capacity)' : 'demand',
    startup_cost_usd: {
      good_case: usd0(t.startup.p10), typical: usd0(t.startup.p50), cautious_case: usd0(t.startup.p90),
      breakdown: Object.fromEntries(Object.entries(t.startup.breakdown).map(([k, v]) => [k, usd0(v)])),
    },
    payback_months: { good_case: months(t.payback.p10), typical: months(t.payback.p50), cautious_case: months(t.payback.p90) },
    chance_of_no_payback_within_5_years: share(t.noPaybackProb),
    chance_of_paying_back_before_the_license_ends: share(t.licensedAtPayback),
    annual_profit_typical_usd: usd0(t.annualProfitP50),
    monthly_at_steady_state_usd: {
      revenue: usd0(t.pnl.revenue), food_and_drink: usd0(t.pnl.food), labor: usd0(t.pnl.labor), rent_incl_nnn: usd0(t.pnl.rent),
      other_costs: usd0(t.pnl.other), net_cash_flow: usd0(t.pnl.net),
    },
  }
}

export function buildNarrativePayload(report: Report, assumptions: Assumption[]) {
  const { inputs, zip, survival, stats } = report
  const meta = dataMeta()
  const rent = meta?.rentByZip[zip.zip]
  const op = inputs.operator
  const given = survival.inputs ? Object.entries(survival.inputs).filter(([, v]) => v.source === 'user').map(([k]) => k) : []
  return {
    owner_request: {
      zip: zip.zip,
      neighborhood: zip.name,
      concept: CUISINE_LABEL[inputs.cuisine],
      service_format: FORMAT_LABEL[inputs.format],
      total_budget_usd: { min: inputs.budgetMin, max: inputs.budgetMax },
      floor_area_sqft: { min: inputs.sqftMin, max: inputs.sqftMax },
      storefront: inputs.storefront === 'both' ? 'vacant shell or second-generation restaurant space' : STOREFRONT_LABEL[inputs.storefront],
      needs_liquor_license: inputs.liquor,
      meal_periods: inputs.dayparts.map((d) => d.replace('_', ' ')),
      risk_appetite: RISK_LABEL[inputs.risk],
      sites_ranked_by: RISK_RULE[inputs.risk],
      about_the_owner: {
        prior_chicago_food_licenses: op.priorLicenses,
        registered_as_company: op.entity,
        address_in_mind: op.address.trim() || null,
      },
    },
    analysis: {
      blocks_in_zip: stats.blocks,
      blocks_that_can_host_a_restaurant: stats.eligible,
      blocks_excluded_for_dry_precincts: stats.moratoriumExcluded,
      plans_screened: stats.screened,
      plans_simulated: stats.simulated,
      simulated_futures_per_plan: report.draws,
      months_simulated: report.horizon,
      plans_within_budget: stats.feasible,
      top_over_budget: report.topOverBudget,
      case_definitions:
        'good_case = 10th percentile of the 1,000 simulated futures (10% pay back sooner); typical = 50th percentile (half pay back sooner); ' +
        'cautious_case = 90th percentile (90% pay back sooner). Payback months of null mean no payback within the months simulated.',
    },
    rent: rent ? { usd_per_sqft_per_year: rent.psf, kind: rent.kind, source: rent.source } : null,
    survival: {
      meaning:
        'Share of similar new independent dine-in restaurants in this ZIP that still held their City of Chicago business license 1,000 days ' +
        '(about 2.7 years) after opening, estimated by a statistical model trained on 2013-2022 openings. It measures license renewal, not ' +
        'whether the restaurant was open, and it is a weak signal: it ranks places only somewhat better than chance.',
      estimate: share(survival.p),
      estimate_with_zip_averages_only: share(survival.pZipDefault),
      owner_inputs_used: given,
      owner_inputs_error: survival.error,
      model_check: meta ? `rolling out-of-time AUC ${meta.survivalModel.aucIndependent} for independents (0.5 = chance, 1 = perfect)` : null,
    },
    sites: report.top.map((t, i) => ({
      rank: i + 1,
      ...planCore(t),
      competition: { score_0_to_100: t.competition.score, level: t.competition.level, details: t.competition.parts.map((p) => `${p.label}: ${p.detail}`) },
      customers: { summary: t.persona.headline, traits: t.persona.tags.map((x) => `${x.label}: ${x.detail}`), fit_for_this_concept_0_to_100: t.persona.fit },
      payback_if_one_driver_moves_10_percent: {
        central_case_months: months(t.basePayback),
        drivers: t.sensitivity.map((s) => ({ driver: s.driver, minus_10_percent: months(s.low), plus_10_percent: months(s.high) })),
      },
      risks: t.risks.map((r) => `${r.level} risk: ${r.text}`),
    })),
    cheapest_plan_if_nothing_fits: !report.top.length && report.cheapest ? planCore(report.cheapest) : null,
    benchmarks: {
      note: 'Shares and percentages are fractions (0.29 = 29%). Each benchmark is a range: low, most likely, high.',
      items: assumptions.map((a) => ({
        label: a.label, low: a.value[0], most_likely: a.value[1], high: a.value[2], unit: a.unit, status: a.status,
        source: a.status === 'unsourced' ? null : a.source, edited_by_you: !!a.edited,
      })),
      total: assumptions.length,
      with_public_source: assumptions.filter((a) => a.status === 'sourced').length,
      partly_sourced: assumptions.filter((a) => a.status === 'partial').length,
      without_public_source: assumptions.filter((a) => a.status === 'unsourced').map((a) => a.label),
      edited_by_you: assumptions.filter((a) => a.edited).map((a) => a.label),
    },
    data_snapshot_date: meta?.asOf ?? null,
    data_sources: meta?.sources ?? {},
    limits: [
      'Revenue, costs and payback come from industry benchmarks, not from local sales records.',
      `Rent is set per ZIP code, not per building${rent?.kind === 'fallback' ? '; this ZIP has no surveyed rent, so the median of 7 surveyed Chicago neighborhoods is used' : ''}.`,
      `Expected number of ${CUISINE_SHORT[inputs.cuisine]} restaurants per block comes from comparing ZIP codes with similar population, jobs and income; it is not a demand forecast.`,
      'The dry-precinct map used for liquor licenses is a 2011 City of Chicago dataset.',
    ],
  }
}
