import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlyToInterpolator, LinearInterpolator, WebMercatorViewport, type MapViewState } from '@deck.gl/core'
import CityMap from './components/CityMap'
import Intake from './components/Intake'
import Analyzing from './components/Analyzing'
import Report, { type Focus } from './components/report/Report'
import { SAMPLE_NOTICE, ZIP_BY_CODE, zipBlocks } from './data/sample'
import { buildAssumptions } from './model/assumptions'
import { runAnalysis } from './model/engine'
import { legendStops, RANK_COLORS } from './colors'
import { CUISINE_SHORT, type Assumption, type Inputs, type Report as R } from './types'

type Stage = 'intake' | 'analyzing' | 'report'

const HOME: MapViewState = { longitude: -87.79, latitude: 41.84, zoom: 10.05, pitch: 56, bearing: -16 }
const DEFAULT_INPUTS: Inputs = {
  zip: '60614',
  budgetMin: 300_000,
  budgetMax: 550_000,
  cuisine: 'italian',
  format: 'full_service',
  sqftMin: 1500,
  sqftMax: 3000,
  storefront: 'both',
  liquor: true,
  dayparts: ['lunch', 'dinner'],
  risk: 'balanced',
}

type Box = [number, number, number, number]
type Pad = { left: number; right: number; top: number; bottom: number }

function mergeEdits(fresh: Assumption[], prev: Assumption[] | null) {
  if (!prev) return fresh
  const edited = new Map(prev.filter((a) => a.edited).map((a) => [a.key, a]))
  return fresh.map((a) => edited.get(a.key) ?? a)
}

export default function App() {
  const [stage, setStage] = useState<Stage>('intake')
  const [inputs, setInputs] = useState<Inputs>(DEFAULT_INPUTS)
  const [assumptions, setAssumptions] = useState<Assumption[] | null>(null)
  const [dirty, setDirty] = useState(false)
  const [report, setReport] = useState<R | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(0)
  const [analysisDone, setAnalysisDone] = useState(false)
  const [site, setSite] = useState(0)
  const [focus, setFocus] = useState<Focus>('summary')
  const [camera, setCamera] = useState<MapViewState>(HOME)
  const [error, setError] = useState<string | null>(null)
  const zip = ZIP_BY_CODE.get(stage === 'intake' ? inputs.zip : (report?.inputs.zip ?? inputs.zip)) ?? null
  const blocks = useMemo(() => (stage !== 'intake' && report ? zipBlocks(report.inputs.zip) : null), [stage, report])

  const fly = useCallback((target: Partial<MapViewState>, duration = 2200) => {
    setCamera((v) => ({ ...v, ...target, transitionDuration: duration, transitionInterpolator: new FlyToInterpolator({ speed: 1.2 }) }) as MapViewState)
  }, [])

  const fitTo = useCallback(
    (box: Box, pad: Pad, maxZoom: number, extra: Partial<MapViewState>, duration = 2200, docked = stage === 'report') => {
      // Use the map's final size: in the report it is docked (and its width is still animating).
      const narrow = window.innerWidth <= 1180
      const width = docked && !narrow ? window.innerWidth * 0.44 : window.innerWidth
      const height = docked && narrow ? window.innerHeight * 0.45 : window.innerHeight
      const vp = new WebMercatorViewport({ width, height })
      const safe = { ...pad }
      if (safe.left + safe.right > width - 80) safe.left = safe.right = 40
      const f = vp.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: safe })
      fly({ longitude: f.longitude, latitude: f.latitude, zoom: Math.min(f.zoom, maxZoom), ...extra }, duration)
    },
    [fly, stage],
  )

  // Landing: slow orbit over the city.
  const orbit = useCallback(() => {
    setCamera({ ...HOME, bearing: HOME.bearing! + 50, transitionDuration: 70000, transitionInterpolator: new LinearInterpolator(['bearing']) } as MapViewState)
  }, [])
  useEffect(() => {
    orbit()
  }, [orbit])

  const sitesBox = (r: R): Box => {
    if (!r.top.length) return r.zip.bbox
    const pad = 0.005
    const lons = r.top.map((t) => t.block.lon), lats = r.top.map((t) => t.block.lat)
    return [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad]
  }

  const changeInputs = (next: Inputs) => {
    if (next.zip !== inputs.zip) {
      const z = ZIP_BY_CODE.get(next.zip)
      if (z) fitTo(z.bbox, { left: 560, right: 80, top: 90, bottom: 90 }, 11.6, { pitch: 54, bearing: -14 }, 2000)
    }
    setInputs(next)
  }

  const submit = () => {
    setBusy(true)
    setError(null)
    setTimeout(() => {
      try {
        const list = mergeEdits(buildAssumptions(inputs), assumptions)
        const r = runAnalysis(inputs, list)
        setAssumptions(list)
        setDirty(false)
        setReport(r)
        setRevealed(0)
        setAnalysisDone(false)
        setSite(0)
        setStage('analyzing')
        fitTo(r.zip.bbox, { left: 80, right: 500, top: 100, bottom: 80 }, 15.1, { pitch: 58, bearing: -22 }, 2600)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    }, 40)
  }

  const onReveal = useCallback((n: number) => setRevealed(n), [])
  const onAnalysisDone = useCallback(() => setAnalysisDone(true), [])
  useEffect(() => {
    if (stage === 'analyzing' && analysisDone && report) fitTo(sitesBox(report), { left: 120, right: 520, top: 140, bottom: 100 }, 16.2, { pitch: 60, bearing: -28 }, 2400)
  }, [stage, analysisDone, report, fitTo])

  const openReport = () => {
    setRevealed(report?.top.length ?? 0)
    setFocus('summary')
    setStage('report')
  }

  // Report: map follows the section being read.
  useEffect(() => {
    if (stage !== 'report' || !report) return
    const id = setTimeout(() => {
      const t = report.top[Math.min(site, report.top.length - 1)]
      if (focus === 'site' && t) fly({ longitude: t.block.lon, latitude: t.block.lat, zoom: 16.1, pitch: 55, bearing: -30 + site * 22 }, 2000)
      else if (focus === 'zip' || !report.top.length) fitTo(report.zip.bbox, { left: 40, right: 40, top: 80, bottom: 60 }, 15, { pitch: 50, bearing: -18 })
      else fitTo(sitesBox(report), { left: 130, right: 90, top: 170, bottom: 110 }, 16, { pitch: 56, bearing: -24 })
    }, 120)
    return () => clearTimeout(id)
  }, [stage, focus, site, report, fly, fitTo])

  const recalc = () => {
    if (!report || !assumptions) return
    const r = runAnalysis(report.inputs, assumptions)
    setReport(r)
    setRevealed(r.top.length)
    setSite((s) => Math.min(s, Math.max(0, r.top.length - 1)))
    setDirty(false)
  }

  const editInputs = () => {
    setStage('intake')
    setRevealed(0)
    if (zip) fitTo(zip.bbox, { left: 560, right: 80, top: 90, bottom: 90 }, 11.6, { pitch: 54, bearing: -14 }, 2200, false)
  }

  const pickSite = useCallback(
    (i: number) => {
      setSite(i)
      if (stage === 'report') {
        document.querySelector('#sec-sites')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    [stage],
  )
  const pickZip = (z: string) => changeInputs({ ...inputs, zip: z })

  const cuisine = report && stage !== 'intake' ? report.inputs.cuisine : inputs.cuisine
  const top = report && stage !== 'intake' ? report.top : []

  return (
    <div className={`app stage-${stage}`}>
      <div className="map-wrap">
        <CityMap
          camera={camera}
          mode={stage === 'intake' ? 'city' : 'zip'}
          cuisine={cuisine}
          zip={zip}
          blocks={blocks}
          shortlist={stage === 'report' && report ? report.matrix.map((m) => m.block) : []}
          top={top}
          revealed={revealed}
          focus={stage === 'report' && focus === 'site' ? site : null}
          scanning={stage === 'analyzing' && !analysisDone}
          onPickSite={pickSite}
          onPickZip={stage === 'intake' ? pickZip : undefined}
        />
        <div className="vignette" />
        <div className="map-hud">
          <div className="brand">
            <span className="logo" />
            <span>Plate<span className="grad">Gap</span></span>
          </div>
          <div className="legend">
            <span className="muted">{CUISINE_SHORT[cuisine]} · saturated</span>
            <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${legendStops(4).join(',')})` }} />
            <span className="muted">unmet demand</span>
          </div>
          {stage === 'report' && report && report.top.length > 0 && (
            <div className="site-chips">
              {report.top.map((t, i) => (
                <button key={t.id} className={focus === 'site' && site === i ? 'on' : ''} onClick={() => pickSite(i)} style={{ ['--accent' as string]: `rgb(${RANK_COLORS[i].join(',')})` }}>
                  <b>#{i + 1}</b> {t.block.street.label}
                </button>
              ))}
            </div>
          )}
          <div className="sample-badge">{SAMPLE_NOTICE}</div>
        </div>
      </div>

      {stage === 'intake' && <div className="scrim" />}
      {stage === 'intake' && <Intake inputs={inputs} onChange={changeInputs} onSubmit={submit} busy={busy} />}
      {stage === 'analyzing' && report && <Analyzing report={report} onReveal={onReveal} onDone={onAnalysisDone} onOpen={openReport} />}
      {stage === 'report' && report && assumptions && (
        <Report
          report={report}
          assumptions={assumptions}
          onAssumptions={(a) => {
            setAssumptions(a)
            setDirty(true)
          }}
          dirty={dirty}
          onRecalc={recalc}
          site={site}
          onSite={setSite}
          onFocus={setFocus}
          onEdit={editInputs}
        />
      )}
      {error && <div className="toast" onClick={() => setError(null)}>{error}</div>}
    </div>
  )
}
