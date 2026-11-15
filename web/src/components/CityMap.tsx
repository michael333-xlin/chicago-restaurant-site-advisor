import { useEffect, useMemo, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { AmbientLight, DirectionalLight, LightingEffect, type MapViewState, type PickingInfo } from '@deck.gl/core'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { ColumnLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { Map } from 'react-map-gl/maplibre'
import { setWorkerUrl } from 'maplibre-gl'
import maplibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { dataNotice, overviewCells } from '../data/blocks'
import { CUISINE_SHORT, type Block, type Cuisine, type PlanDetail, type ZipInfo } from '../types'
import { gapColor, gapSpan, RANK_COLORS } from '../colors'
import { useTween } from '../hooks'

// maplibre-gl 6 resolves its worker relative to its own module; bundled builds must point at the emitted file.
setWorkerUrl(maplibreWorker)

const STYLE_LABELS = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const STYLE_CLEAN = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json'

const lighting = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.15 }),
  key: new DirectionalLight({ color: [255, 226, 196], intensity: 1.4, direction: [-2, -4, -3] }),
  fill: new DirectionalLight({ color: [140, 160, 255], intensity: 0.5, direction: [3, 2, -1] }),
})

const NO_DEPTH = { depthCompare: 'always', depthWriteEnabled: false } as const

export type MapMode = 'city' | 'zip'

type Props = {
  camera: MapViewState // camera target; deck.gl owns the per-frame view state (uncontrolled)
  mode: MapMode
  cuisine: Cuisine
  zip: ZipInfo | null
  blocks: Block[] | null
  shortlist: Block[]
  top: PlanDetail[]
  revealed: number
  focus: number | null
  scanning: boolean
  onPickSite?: (i: number) => void
  onPickZip?: (zip: string) => void
}

function useClock(active: boolean, period: number) {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (!active) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      setT(((now - start) / period) % 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, period])
  return t
}

const blockHeight = (b: Block, c: Cuisine) => (b.eligible ? 24 + Math.sqrt(Math.max(0, b.cuisine[c].expected)) * 78 : 5)
const BEACON = 640

export default function CityMap(p: Props) {
  const { mode, cuisine, zip, blocks, top, revealed, focus, shortlist, scanning, onPickSite, onPickZip } = p
  const pulse = useClock(mode === 'zip' && revealed > 0, 1800)
  const sweep = useClock(scanning, 2200)
  const overview = useMemo(() => overviewCells(), [])
  const shown = useMemo(() => top.slice(0, revealed), [top, revealed])
  // flatten the blocks smoothly when a site is focused (elevationScale is a uniform: cheap to animate per frame)
  const flat = useTween(focus != null ? 0.14 : 1, true, 700)
  const dim = focus != null
  // colour span from the data on screen: citywide eligible cells, or the open ZIP's eligible blocks
  const citySpan = useMemo(() => gapSpan(overview.filter((o) => o.block.eligible).map((o) => o.block.cuisine[cuisine].expected - o.block.cuisine[cuisine].actual)), [overview, cuisine])
  const zipSpan = useMemo(() => (blocks ? gapSpan(blocks.filter((b) => b.eligible).map((b) => b.cuisine[cuisine].expected - b.cuisine[cuisine].actual)) : citySpan), [blocks, cuisine, citySpan])
  const COLOR_T = { duration: 700, easing: (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2) }

  const overviewLayer = useMemo(
    () =>
      new H3HexagonLayer<(typeof overview)[number]>({
        id: 'overview',
        data: overview,
        visible: mode === 'city',
        getHexagon: (d) => d.h3,
        extruded: true,
        coverage: 0.86,
        pickable: true,
        getElevation: (d) => 60 + Math.sqrt(Math.max(0, d.block.cuisine[cuisine].expected)) * 950,
        getFillColor: (d) => {
          const c = gapColor(d.block.cuisine[cuisine].expected - d.block.cuisine[cuisine].actual, 225, citySpan)
          if (zip && d.zip !== zip.zip) return [c[0], c[1], c[2], 70]
          return c
        },
        updateTriggers: { getElevation: cuisine, getFillColor: [cuisine, zip?.zip, citySpan] },
        material: { ambient: 0.5, diffuse: 0.7, shininess: 40, specularColor: [255, 220, 180] },
        transitions: { getElevation: { duration: 1200, enter: () => [0] }, getFillColor: COLOR_T },
        onClick: (info) => info.object && onPickZip?.(info.object.zip),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- COLOR_T is a constant
    [overview, mode, cuisine, zip, onPickZip, citySpan],
  )

  const outline = useMemo(
    () =>
      zip
        ? [
            new PathLayer<[number, number][]>({
              id: 'zip-glow', data: zip.polygons, getPath: (d) => d, getColor: [255, 178, 72, 60], getWidth: 14, widthUnits: 'pixels', parameters: NO_DEPTH,
            }),
            new PathLayer<[number, number][]>({
              id: 'zip-line', data: zip.polygons, getPath: (d) => d, getColor: [255, 214, 160, 230], getWidth: 2, widthUnits: 'pixels', parameters: NO_DEPTH,
            }),
          ]
        : [],
    [zip],
  )

  const topSet = useMemo(() => new Set(shown.map((t) => t.block.h3)), [shown])
  const blockLayer = useMemo(
    () =>
      blocks && mode === 'zip'
        ? new H3HexagonLayer<Block>({
            id: `blocks-${zip?.zip}`,
            data: blocks,
            getHexagon: (d) => d.h3,
            extruded: true,
            coverage: 0.88,
            elevationScale: flat,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 60],
            getElevation: (d) => (topSet.has(d.h3) ? blockHeight(d, cuisine) + 60 : blockHeight(d, cuisine)),
            getFillColor: (d) => {
              const i = shown.findIndex((t) => t.block.h3 === d.h3)
              if (i >= 0) return [...RANK_COLORS[i], 255] as [number, number, number, number]
              if (!d.eligible) return [58, 64, 82, dim ? 40 : 90]
              return gapColor(d.cuisine[cuisine].expected - d.cuisine[cuisine].actual, dim ? 150 : 228, zipSpan)
            },
            updateTriggers: { getElevation: [cuisine, revealed], getFillColor: [cuisine, revealed, dim, zipSpan] },
            material: { ambient: 0.45, diffuse: 0.75, shininess: 60, specularColor: [255, 220, 180] },
            transitions: { getElevation: { duration: 1400, enter: () => [0] }, getFillColor: COLOR_T },
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- COLOR_T is a constant
    [blocks, mode, zip, cuisine, topSet, shown, revealed, flat, dim, zipSpan],
  )

  const shortlistLayer = useMemo(
    () =>
      new ScatterplotLayer<Block>({
        id: 'shortlist',
        data: mode === 'zip' ? shortlist.filter((b) => !topSet.has(b.h3)) : [],
        getPosition: (d) => [d.lon, d.lat, blockHeight(d, cuisine) * flat + 4],
        getRadius: 16,
        radiusMinPixels: 3,
        stroked: true,
        lineWidthMinPixels: 1.5,
        getFillColor: [12, 14, 20, 220],
        getLineColor: [170, 185, 255, 230],
        parameters: NO_DEPTH,
      }),
    [mode, shortlist, topSet, cuisine, flat],
  )

  const markerLayers = useMemo(() => {
    if (mode !== 'zip' || !shown.length) return []
    const data = shown.map((t, i) => ({ t, i, color: RANK_COLORS[i] }))
    type D = (typeof data)[number]
    const pos = (d: D, z = 0): [number, number, number] => [d.t.block.lon, d.t.block.lat, z]
    const beacon = BEACON * (dim ? 0.45 : 1)
    const focused = focus != null ? data.filter((d) => d.i === focus) : []
    return [
      new ScatterplotLayer<D>({
        id: 'focus-radius',
        data: focused,
        getPosition: (d) => pos(d, 2),
        getRadius: 300,
        stroked: true,
        filled: true,
        getFillColor: (d) => [...d.color, 22] as [number, number, number, number],
        getLineColor: (d) => [...d.color, 200] as [number, number, number, number],
        lineWidthMinPixels: 1.5,
        parameters: NO_DEPTH,
      }),
      new ScatterplotLayer<D>({
        id: 'pulse',
        data,
        getPosition: (d) => pos(d, 1),
        getRadius: 40 + pulse * 260,
        stroked: true,
        filled: false,
        lineWidthMinPixels: 2,
        getLineColor: (d) => [...d.color, Math.round(230 * (1 - pulse))] as [number, number, number, number],
        updateTriggers: { getRadius: pulse, getLineColor: pulse },
        parameters: NO_DEPTH,
      }),
      new ColumnLayer<D>({
        id: 'beacon-halo',
        data,
        diskResolution: 24,
        radius: 46,
        extruded: true,
        getPosition: (d) => pos(d),
        getElevation: beacon,
        getFillColor: (d) => [...d.color, 60] as [number, number, number, number],
        material: false,
        transitions: { getElevation: { duration: 900, enter: () => [0] } },
      }),
      new ColumnLayer<D>({
        id: 'beacon',
        data,
        diskResolution: 16,
        radius: 15,
        extruded: true,
        pickable: true,
        getPosition: (d) => pos(d),
        getElevation: beacon,
        getFillColor: (d) => [...d.color, 255] as [number, number, number, number],
        material: { ambient: 1, diffuse: 0.2, shininess: 0 },
        transitions: { getElevation: { duration: 900, enter: () => [0] } },
        onClick: (info) => info.object && onPickSite?.(info.object.i),
      }),
      new TextLayer<D>({
        id: 'rank',
        data,
        getPosition: (d) => pos(d, beacon + 30),
        getText: (d) => `#${d.i + 1}`,
        getSize: (d) => (d.i === focus ? 20 : 16),
        fontFamily: 'Space Grotesk, Inter, sans-serif',
        fontWeight: 700,
        getColor: [14, 12, 10, 255],
        background: true,
        getBackgroundColor: (d) => (d.i === focus ? [255, 255, 255, 255] : [...d.color, 255]) as [number, number, number, number],
        backgroundBorderRadius: 10,
        backgroundPadding: [8, 4],
        updateTriggers: { getSize: focus, getBackgroundColor: focus },
        pickable: true,
        onClick: (info) => info.object && onPickSite?.(info.object.i),
        parameters: NO_DEPTH,
      }),
      new TextLayer<D>({
        id: 'rank-label',
        data,
        getPosition: (d) => pos(d, beacon + 30),
        getText: (d) => d.t.block.street.label,
        getSize: 12,
        getPixelOffset: [0, 26],
        fontFamily: 'Inter, sans-serif',
        fontWeight: 600,
        characterSet: 'auto',
        getColor: [244, 239, 232, 240],
        background: true,
        getBackgroundColor: [10, 12, 18, 210],
        backgroundBorderRadius: 6,
        backgroundPadding: [6, 3],
        parameters: NO_DEPTH,
      }),
    ]
  }, [mode, shown, pulse, focus, onPickSite, dim])

  const scanLayer = useMemo(() => {
    if (!scanning || !zip) return null
    const r = Math.max(zip.bbox[2] - zip.bbox[0], zip.bbox[3] - zip.bbox[1]) * 111000 * 0.6
    return new ScatterplotLayer<number>({
      id: 'scan',
      data: [0, 0.5],
      getPosition: () => [zip.center[0], zip.center[1], 3],
      getRadius: (k) => ((sweep + k) % 1) * r,
      stroked: true,
      filled: true,
      getFillColor: (k) => [255, 178, 72, Math.round(26 * (1 - ((sweep + k) % 1)))],
      getLineColor: (k) => [255, 208, 138, Math.round(220 * (1 - ((sweep + k) % 1)))],
      lineWidthMinPixels: 2,
      updateTriggers: { getRadius: sweep, getFillColor: sweep, getLineColor: sweep },
      parameters: NO_DEPTH,
    })
  }, [scanning, zip, sweep])

  const getTooltip = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return null
    const style = {
      background: 'rgba(12,14,20,0.94)', color: '#f4efe8', borderRadius: '10px', padding: '8px 10px',
      border: '1px solid rgba(255,255,255,0.1)', fontFamily: 'Inter, sans-serif', fontSize: '12px', maxWidth: '260px',
    }
    const name = CUISINE_SHORT[cuisine]
    if (layer.id === 'overview') {
      const o = object as (typeof overview)[number]
      const c = o.block.cuisine[cuisine]
      return { html: `<b>ZIP ${o.zip}</b><br/>${name}: ${c.actual} open vs ${c.expected.toFixed(1)} expected nearby<br/><span style="opacity:.55">Click to choose this ZIP · ${dataNotice()}</span>`, style }
    }
    if (layer.id.startsWith('blocks-')) {
      const b = object as Block
      const c = b.cuisine[cuisine]
      const gap = c.expected - c.actual
      return {
        html: `<b>${b.street.label}</b> <span style="opacity:.55">${b.street.grid}</span><br/>${name} within ~300 m: ${c.actual} open · ${c.expected.toFixed(1)} expected · gap <b>${gap >= 0 ? '+' : ''}${gap.toFixed(1)}</b><br/>Rent est. $${b.rentPsf}/sq ft/yr (${b.rentKind})${b.eligible ? '' : ' · <i>no food businesses nearby</i>'}${b.liquorMoratorium ? '<br/><span style="color:#ff8a95">Liquor moratorium segment</span>' : ''}<br/><span style="opacity:.5">${dataNotice()}</span>`,
        style,
      }
    }
    if (layer.id === 'beacon' || layer.id === 'rank') {
      const d = object as { t: PlanDetail; i: number }
      return { html: `<b>#${d.i + 1} · ${d.t.block.street.label}</b><br/>${d.t.block.street.grid}<br/>Click to open the site deep-dive`, style }
    }
    return null
  }

  return (
    <DeckGL
      initialViewState={p.camera}
      controller={{ dragRotate: true, inertia: 300 }}
      layers={[overviewLayer, blockLayer, ...outline, shortlistLayer, scanLayer, ...markerLayers]}
      effects={[lighting]}
      getTooltip={getTooltip}
      getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
    >
      <Map mapStyle={mode === 'zip' ? STYLE_LABELS : STYLE_CLEAN} reuseMaps />
    </DeckGL>
  )
}
