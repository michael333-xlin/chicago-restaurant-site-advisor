import type * as React from 'react'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, OrbitControls } from '@react-three/drei'

export type StorefrontSpec = {
  sqft: number                 // 1000–4500 total leasable area
  format: 'quick_service' | 'fast_casual' | 'full_service'
  cuisine: 'italian' | 'steakhouse' | 'fast_food' | 'asian'
  seats: number                // dining seats, 0–160
  hasBar: boolean              // liquor license -> show a bar counter with stools
  storefront: 'vacant' | 'second_gen'
}

/* ------------------------------------------------------------------ */
/* Constants (layout units are feet; the whole model is scaled to fit) */
/* ------------------------------------------------------------------ */

type Vec3 = [number, number, number]
type Shape = 'box' | 'cyl' | 'dome' | 'bowl'

const DUR = 0.42 // per-object build-in duration (s)
const RISE = 2.2 // ft an object rises from below the slab while building in
const T = 0.6 // exterior wall thickness
const WALL_H = 4 // cut-away exterior wall height
const PART_H = 3.2 // interior partition height
const FACADE_H = 10 // storefront glass height
const HEADER_TOP = 12.4 // top of the sign band
const SIDEWALK = 7
const FIT_R = 5.2 // world-space radius the footprint is scaled to
const FIT_V = 4.5 // world-space vertical half-extent used to fit the camera
const CAM_FOV = 30
const TARGET: Vec3 = [0, 0.05, 0]
const INITIAL_CAMERA: Vec3 = (() => {
  const polar = 0.74
  const dist = 20
  const h = dist * Math.sin(polar)
  return [h * 0.55, TARGET[1] + dist * Math.cos(polar), h * 0.835]
})()

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  lineHeight: '14px',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'rgba(244,239,232,0.7)',
  whiteSpace: 'nowrap',
  padding: '2px 7px',
  borderRadius: 3,
  background: 'rgba(7,9,13,0.55)',
  border: '1px solid rgba(244,239,232,0.08)',
  userSelect: 'none',
  pointerEvents: 'none',
  position: 'absolute',
  left: 0,
  top: 0,
  willChange: 'transform',
}

/* Geometry: unit primitives with their base at y = 0 so scaling y grows them from the floor. */
const GEO: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 16).translate(0, 0.5, 0),
  dome: new THREE.SphereGeometry(0.5, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2, 1),
  bowl: new THREE.SphereGeometry(0.5, 14, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
    .scale(1, 2, 1)
    .translate(0, 1, 0),
}
const EDGES: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.EdgesGeometry(GEO.box),
  cyl: new THREE.EdgesGeometry(GEO.cyl, 30),
  dome: new THREE.EdgesGeometry(GEO.dome, 20),
  bowl: new THREE.EdgesGeometry(GEO.bowl, 20),
}

function std(color: string, params: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.04, ...params })
}
function glow(emissive: string, intensity: number, base: string) {
  return std(base, { emissive, emissiveIntensity: intensity, roughness: 0.6 })
}

const MAT = {
  floor: std('#151a24', { roughness: 0.95 }),
  sidewalk: std('#10141b', { roughness: 1 }),
  zoneDining: std('#1a1f2b', { roughness: 0.9 }),
  zoneService: std('#171c27', { roughness: 0.9 }),
  zoneKitchen: std('#11151c', { roughness: 0.9 }),
  zoneRest: std('#1b2231', { roughness: 0.9 }),
  wall: std('#1c2230', { roughness: 0.88 }),
  wallCap: std('#2b3346', { roughness: 0.7 }),
  partition: std('#212838'),
  glass: std('#9fb4ff', { transparent: true, opacity: 0.1, roughness: 0.08, metalness: 0.3, depthWrite: false }),
  mullion: std('#0c0f15', { metalness: 0.4, roughness: 0.45 }),
  signBack: std('#0e1117'),
  sign: glow('#ffb248', 1.25, '#3a2410'),
  ember: glow('#ff5c38', 1.6, '#2a0e06'),
  amber: glow('#ffb248', 1.1, '#2a1a08'),
  hoodGlow: glow('#ffb248', 2.0, '#3a2410'),
  oil: glow('#ffb248', 0.45, '#2a1d0a'),
  screen: glow('#ffb248', 0.25, '#0c0f15'),
  menu: glow('#ff8a3d', 0.12, '#0d1016'),
  wood: std('#b07a4a', { roughness: 0.62 }),
  woodDark: std('#5a3b25', { roughness: 0.7 }),
  counter: std('#262c3a'),
  chair: std('#2a2f3b'),
  tableBase: std('#1d212b', { metalness: 0.25 }),
  stoolSeat: std('#3b2a20'),
  steel: std('#7f8898', { metalness: 0.25, roughness: 0.45 }),
  steelLight: std('#a3acbb', { metalness: 0.25, roughness: 0.4 }),
  steelDark: std('#3b4252', { metalness: 0.25, roughness: 0.5 }),
  grate: std('#14171d', { roughness: 0.6 }),
  walkin: std('#8d96a6', { metalness: 0.2, roughness: 0.5 }),
  walkinDoor: std('#b3bbc8', { metalness: 0.2, roughness: 0.45 }),
  hood: std('#9aa3b3', { metalness: 0.3, roughness: 0.4 }),
  brick: std('#7d4a33', { roughness: 0.92 }),
  brickDark: std('#4a2d22', { roughness: 0.9 }),
  wok: std('#262a31', { metalness: 0.5, roughness: 0.35, side: THREE.DoubleSide }),
  porcelain: std('#cfd4dc', { roughness: 0.3 }),
  // "to be built" ghost for vacant shells
  ghost: std('#6f7dff', {
    transparent: true,
    opacity: 0.16,
    emissive: '#6f7dff',
    emissiveIntensity: 0.4,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
}
type MatKey = keyof typeof MAT
const GHOST_EDGE = new THREE.LineBasicMaterial({ color: '#8d98ff', transparent: true, opacity: 0.75 })

type Fmt = { t4: number; t2: number; chair: number; gap: number; mod: number; avg: number; tableH: number }
const FORMATS: Record<StorefrontSpec['format'], Fmt> = {
  // t4/t2: table sizes; mod: target grid module; avg: average seats per table when mixing 2- and 4-tops
  quick_service: { t4: 2.4, t2: 2.0, chair: 1.1, gap: 0.1, mod: 4.6, avg: 2.4, tableH: 2.45 },
  fast_casual: { t4: 2.8, t2: 2.3, chair: 1.25, gap: 0.1, mod: 5.4, avg: 3.0, tableH: 2.5 },
  full_service: { t4: 3.0, t2: 2.5, chair: 1.4, gap: 0.1, mod: 6.0, avg: 3.3, tableH: 2.5 },
}
const FORMAT_NAME: Record<StorefrontSpec['format'], string> = {
  quick_service: 'quick service',
  fast_casual: 'fast casual',
  full_service: 'full service',
}
const SIGNATURE_WIDTH: Record<StorefrontSpec['cuisine'], number> = {
  italian: 5.6,
  steakhouse: 4.2,
  fast_food: 4.6,
  asian: 5.4,
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

type Part = { shape: Shape; pos: Vec3; size: Vec3; mat: MatKey }
type BuildGroup = { id: string; delay: number; ghost: boolean; parts: Part[] }
type Inst = { x: number; y: number; z: number; sx: number; sy: number; sz: number; delay: number }
type LabelSpec = { id: string; text: string; pos: Vec3; delay: number }
type Rect = { x0: number; x1: number; z0: number; z1: number }
type Layout = {
  scale: number
  centerZ: number
  ghost: boolean
  summary: string
  groups: BuildGroup[]
  tableTops: Inst[]
  tableBases: Inst[]
  chairs: Inst[]
  chairBacks: Inst[]
  stoolSeats: Inst[]
  stoolPosts: Inst[]
  labels: LabelSpec[]
  grid: Float32Array
  dims: Float32Array
  hoodLight: Vec3
  signLight: Vec3
  diningLight: Vec3
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: MatKey): Part {
  return { shape: 'box', pos: [(x0 + x1) / 2, y0, (z0 + z1) / 2], size: [x1 - x0, y1 - y0, z1 - z0], mat }
}
function prim(shape: Shape, cx: number, y0: number, cz: number, diameter: number, h: number, mat: MatKey): Part {
  return { shape, pos: [cx, y0, cz], size: [diameter, h, diameter], mat }
}

/** Number of grid modules along `len`, keeping each module at least as big as a table footprint. */
function fitCount(len: number, mod: number, foot: number) {
  let n = Math.max(0, Math.round(len / mod))
  while (n > 0 && len / n < foot + 0.2) n -= 1
  return n
}

/** Mix of 4-tops and 2-tops to seat `seats` within `slots` table positions. */
function planTables(seats: number, slots: number, avg: number) {
  if (seats <= 0 || slots <= 0) return { n4: 0, n2: 0, capacity: 0 }
  const target = seats + (seats % 2)
  const tables = Math.min(slots, clamp(Math.round(target / avg), Math.ceil(target / 4), target / 2))
  const n4 = clamp((target - 2 * tables) / 2, 0, tables)
  const n2 = tables - n4
  return { n4, n2, capacity: 4 * n4 + 2 * n2 }
}

function signatureParts(cuisine: StorefrontSpec['cuisine'], x0: number, z0: number, z1: number): Part[] {
  const zc = (z0 + z1) / 2
  switch (cuisine) {
    case 'italian': {
      // wood-fired pizza oven dome
      const cx = x0 + 2.8
      return [
        box(x0, x0 + 5.6, 0, 3, z0, z0 + 5, 'brickDark'),
        prim('dome', cx, 3, z0 + 2.5, 5, 2.6, 'brick'),
        box(cx - 0.9, cx + 0.9, 3.1, 4.1, z0 + 4.82, z0 + 5.08, 'ember'),
        prim('cyl', cx, 5.4, z0 + 2.2, 0.8, 1.1, 'steelDark'),
      ]
    }
    case 'steakhouse': {
      // char grill with ember bed and grate bars
      const parts = [
        box(x0, x0 + 4.2, 0, 2.9, z0, z1, 'steelDark'),
        box(x0 + 0.25, x0 + 3.95, 2.9, 3.0, z0 + 0.3, z1 - 0.3, 'ember'),
      ]
      for (let i = 0; i < 6; i += 1) {
        const bx = x0 + 0.5 + i * 0.64
        parts.push(box(bx - 0.06, bx + 0.06, 3.0, 3.12, z0 + 0.25, z1 - 0.25, 'grate'))
      }
      return parts
    }
    case 'fast_food': {
      // bank of three fryers
      const parts: Part[] = []
      for (let i = 0; i < 3; i += 1) {
        const fx = x0 + i * 1.53
        parts.push(box(fx, fx + 1.45, 0, 3, z0, z1, 'steel'))
        parts.push(box(fx + 0.2, fx + 1.25, 3.0, 3.06, z0 + 0.35, z1 - 0.55, 'oil'))
      }
      return parts
    }
    case 'asian': {
      // two-wok range
      const parts = [box(x0, x0 + 5.4, 0, 2.9, z0, z1, 'steelDark')]
      for (const cx of [x0 + 1.35, x0 + 4.05]) {
        parts.push(prim('cyl', cx, 2.9, zc, 1.6, 0.1, 'ember'))
        parts.push(prim('bowl', cx, 2.98, zc, 2.1, 0.75, 'wok'))
      }
      return parts
    }
  }
}

function computeLayout(spec: StorefrontSpec): Layout {
  const sqft = clamp(spec.sqft, 1000, 4500)
  const seatsReq = Math.max(0, Math.round(spec.seats))
  const fmt = FORMATS[spec.format]
  const isFS = spec.format === 'full_service'
  const isQS = spec.format === 'quick_service'
  const ghost = spec.storefront === 'vacant'

  // Chicago storefront: 25 ft frontage, widened in 5 ft steps (max 40) so depth stays ~100 ft.
  const W = clamp(Math.ceil(sqft / 500) * 5, 25, 40)
  const D = sqft / W
  const xL = -W / 2
  const xR = W / 2
  const zR = -D / 2 // rear
  const zF = D / 2 // storefront glass

  // Right-hand strip at the back: corridor to the restrooms (rear corner).
  const Wr = clamp(W * 0.3, 7.5, 10)
  const xC = xR - Wr
  // Kitchen gets its share of the total area (excluding the corridor strip).
  const Dk = Math.min(((isFS ? 0.33 : 0.4) * sqft) / (W - Wr), D * 0.55)
  const zK = zR + Dk // kitchen front (partition)
  const zS = zK + (isFS ? 4.5 : 6) // service zone front / dining rear
  const Dd = zF - zS
  const Dr = Math.min(9, Dk - 5)
  const zRestFront = zR + T + Dr

  const doorX1 = xR - 2.2
  const doorX0 = doorX1 - 3.5

  const groups: BuildGroup[] = []
  const add = (id: string, delay: number, parts: Part[], isGhost = false) => {
    groups.push({ id, delay, ghost: isGhost, parts })
  }
  const labels: LabelSpec[] = []
  const reserved: Rect[] = []
  const tableTops: Inst[] = []
  const tableBases: Inst[] = []
  const chairs: Inst[] = []
  const chairBacks: Inst[] = []
  const stoolSeats: Inst[] = []
  const stoolPosts: Inst[] = []
  const addStool = (x: number, z: number, h: number, delay: number) => {
    stoolPosts.push({ x, y: 0, z, sx: 0.28, sy: h, sz: 0.28, delay })
    stoolSeats.push({ x, y: h, z, sx: 1.25, sy: 0.24, sz: 1.25, delay: delay + 0.04 })
  }

  /* ---- Floor slab, sidewalk, zone tints ---- */
  add('floor', 0, [
    box(xL - 0.3, xR + 0.3, -1, 0, zR - 0.3, zF, 'floor'),
    box(xL - 0.3, xR + 0.3, -1, -0.3, zF, zF + SIDEWALK, 'sidewalk'),
    box(xL + T, xR - T, 0, 0.03, zS, zF - 0.3, 'zoneDining'),
    box(xL + T, xR - T, 0, 0.03, zK, zS, 'zoneService'),
    box(xL + T, xC, 0, 0.03, zR + T, zK, 'zoneKitchen'),
    box(xC, xR - T, 0, 0.03, zRestFront, zK, 'zoneService'),
    box(xC, xR - T, 0, 0.03, zR + T, zRestFront, 'zoneRest'),
  ])

  /* ---- Cut-away walls on three sides ---- */
  const sideEnd = zF - 1.2
  add('wall-left', 0.05, [
    box(xL, xL + T, 0, WALL_H, zR, sideEnd, 'wall'),
    box(xL - 0.04, xL + T + 0.04, WALL_H, WALL_H + 0.14, zR, sideEnd, 'wallCap'),
  ])
  add('wall-rear', 0.09, [
    box(xL, xR, 0, WALL_H, zR, zR + T, 'wall'),
    box(xL - 0.04, xR + 0.04, WALL_H, WALL_H + 0.14, zR - 0.04, zR + T + 0.04, 'wallCap'),
  ])
  add('wall-right', 0.13, [
    box(xR - T, xR, 0, WALL_H, zR, sideEnd, 'wall'),
    box(xR - T - 0.04, xR + 0.04, WALL_H, WALL_H + 0.14, zR, sideEnd, 'wallCap'),
  ])

  /* ---- Glass storefront with door, pilasters and sign band ---- */
  const fz0 = zF - 0.4
  const paneX0 = xL + 1.2
  const paneX1 = xR - 1.2
  const facade: Part[] = [
    box(xL, xL + 1.2, 0, HEADER_TOP, zF - 1.2, zF + 0.05, 'wall'),
    box(xR - 1.2, xR, 0, HEADER_TOP, zF - 1.2, zF + 0.05, 'wall'),
    box(xL, xR, FACADE_H, HEADER_TOP, zF - 0.9, zF, 'wall'),
    box(xL - 0.2, xR + 0.2, HEADER_TOP, HEADER_TOP + 0.25, zF - 1.1, zF + 0.25, 'wallCap'),
    box(paneX0, doorX0, 0, 1.4, fz0, zF, 'wall'),
    box(doorX1, paneX1, 0, 1.4, fz0, zF, 'wall'),
    box(paneX0, doorX0, 1.32, 1.46, fz0 - 0.05, zF + 0.02, 'mullion'),
    box(doorX1, paneX1, 1.32, 1.46, fz0 - 0.05, zF + 0.02, 'mullion'),
    box(paneX0, doorX0, 1.46, FACADE_H, zF - 0.28, zF - 0.14, 'glass'),
    box(doorX1, paneX1, 1.46, FACADE_H, zF - 0.28, zF - 0.14, 'glass'),
    box(doorX0, doorX1, 0.05, 7.8, zF - 0.28, zF - 0.14, 'glass'),
    box(doorX0, doorX1, 8.05, FACADE_H, zF - 0.28, zF - 0.14, 'glass'),
    box(doorX0 - 0.15, doorX0 + 0.1, 0, FACADE_H, fz0, zF, 'mullion'),
    box(doorX1 - 0.1, doorX1 + 0.15, 0, FACADE_H, fz0, zF, 'mullion'),
    box(doorX0, doorX1, 7.8, 8.05, fz0, zF, 'mullion'),
    box(doorX0 + 0.35, doorX0 + 0.5, 3.1, 4.5, zF - 0.1, zF + 0.12, 'amber'),
  ]
  const paneLen = doorX0 - paneX0
  const mullions = Math.max(0, Math.ceil(paneLen / 7) - 1)
  for (let i = 1; i <= mullions; i += 1) {
    const x = paneX0 + (paneLen * i) / (mullions + 1)
    facade.push(box(x - 0.12, x + 0.12, 1.46, FACADE_H, fz0, zF, 'mullion'))
  }
  add('facade', 0.18, facade)
  const signW = W * 0.5
  add('sign', 0.3, [
    box(-signW / 2 - 0.2, signW / 2 + 0.2, 10.3, 12.1, zF, zF + 0.14, 'signBack'),
    box(-signW / 2, signW / 2, 10.75, 11.85, zF + 0.14, zF + 0.3, 'sign'),
    box(-signW / 2, signW / 2, 10.45, 10.55, zF + 0.14, zF + 0.26, 'ember'),
  ])

  /* ---- Interior partitions & restrooms (rear corner) ---- */
  const gapX0 = xC - 4.4
  const gapX1 = xC - 0.9
  add('partitions', 0.24, [
    box(xL + T, gapX0, 0, PART_H, zK - 0.2, zK + 0.2, 'partition'),
    box(gapX1, xC + 0.2, 0, PART_H, zK - 0.2, zK + 0.2, 'partition'),
    box(xC - 0.2, xC + 0.2, 0, PART_H, zR + T, zK - 0.2, 'partition'),
  ])
  const roomX = xC + 0.2
  const roomW = (xR - T - roomX) / 2
  const rest: Part[] = [box(roomX + roomW - 0.12, roomX + roomW + 0.12, 0, PART_H, zR + T, zRestFront, 'partition')]
  for (let i = 0; i < 2; i += 1) {
    const x0 = roomX + i * roomW
    const x1 = x0 + roomW
    const tx = x0 + roomW * 0.42
    const sinkZ = zR + T + Dr * 0.62
    rest.push(box(x0, x1 - 2.5, 0, PART_H, zRestFront - 0.2, zRestFront + 0.2, 'partition'))
    rest.push(box(tx - 0.7, tx + 0.7, 0, 2.5, zR + T, zR + T + 0.6, 'porcelain'))
    rest.push({ shape: 'cyl', pos: [tx, 0, zR + T + 1.45], size: [1.2, 1.35, 1.7], mat: 'porcelain' })
    rest.push(box(x1 - 1.5, x1 - 0.15, 2.4, 2.85, sinkZ - 0.8, sinkZ + 0.8, 'porcelain'))
  }
  add('restrooms', 0.28, rest)
  labels.push({ id: 'rest', text: 'Restrooms', pos: [roomX + roomW, 6, zR + T + Dr / 2], delay: 0.9 })

  /* ---- Kitchen (rear): line + hood, walk-in, prep, dish ---- */
  const kx0 = xL + T + 0.1
  const kx1 = xC - 0.3
  const kz0 = zR + T + 0.1
  const kz1 = zK - 0.3
  const Kw = kx1 - kx0
  const lx0 = kx0 + 0.3
  const lx1 = kx1 - 0.3
  const lz1 = kz0 + 2.6

  add('line-back', 0.3, [box(lx0, lx1, 3, 4.4, kz0, kz0 + 0.2, 'steel')], ghost)
  add('signature', 0.32, signatureParts(spec.cuisine, lx0, kz0, lz1), ghost)
  const lineStart = lx0 + SIGNATURE_WIDTH[spec.cuisine] + 0.2
  const pieces = Math.max(1, Math.floor((lx1 - lineStart) / 3))
  const pieceW = (lx1 - lineStart) / pieces
  for (let i = 0; i < pieces; i += 1) {
    const x0 = lineStart + i * pieceW
    const x1 = x0 + pieceW
    add(
      `line-${i}`,
      0.34 + i * 0.025,
      [
        box(x0 + 0.05, x1 - 0.05, 0, 3, kz0, lz1, i % 2 === 0 ? 'steel' : 'steelLight'),
        box(x0 + 0.25, x1 - 0.25, 3, 3.08, kz0 + 0.35, lz1 - 0.2, 'grate'),
      ],
      ghost,
    )
  }
  const hx0 = lx0 - 0.3
  const hx1 = lx1 + 0.3
  const hcx = (hx0 + hx1) / 2
  add(
    'hood',
    0.46,
    [
      box(hx0, hx1, 6.6, 8.4, kz0, kz0 + 4.2, 'hood'),
      box(hx0 + 0.25, hx1 - 0.25, 6.5, 6.6, kz0 + 0.3, kz0 + 3.9, 'hoodGlow'),
      box(hcx - 0.9, hcx + 0.9, 8.4, 11, kz0 + 0.6, kz0 + 2.4, 'hood'),
    ],
    ghost,
  )

  const midZ0 = lz1 + 4
  const walkW = clamp(Kw * 0.38, 6, 10)
  const walkD = clamp(kz1 - 0.3 - midZ0, 4.5, 10)
  const walkX1 = kx0 + walkW
  const walkZ1 = midZ0 + walkD
  const walkZc = (midZ0 + walkZ1) / 2
  add(
    'walkin',
    0.36,
    [
      box(kx0, walkX1, 0, 8, midZ0, walkZ1, 'walkin'),
      box(walkX1, walkX1 + 0.1, 0.15, 6.9, walkZc - 1.4, walkZc + 1.4, 'walkinDoor'),
      box(walkX1 + 0.1, walkX1 + 0.24, 3.2, 4.2, walkZc + 0.9, walkZc + 1.1, 'amber'),
      box(kx0 + 0.8, kx0 + 3.4, 8, 9.1, midZ0 + 0.8, midZ0 + 2.8, 'steelDark'),
    ],
    ghost,
  )

  const dishX1 = gapX0 - 0.3
  const dishX0 = Math.max(dishX1 - clamp(Kw * 0.35, 4.5, 8), walkX1 + 0.8)
  const dishZ0 = kz1 - 2.6
  const dish: Part[] = [
    box(dishX0, dishX1, 0, 2.9, dishZ0, kz1, 'steel'),
    box(dishX1 - 2.4, dishX1 - 0.1, 2.9, 5.6, dishZ0 + 0.15, kz1 - 0.15, 'steelLight'),
  ]
  const sinkW = dishX1 - 2.6 - (dishX0 + 0.3)
  if (sinkW > 0.6) {
    const basins = sinkW > 2 ? 2 : 1
    const bw = (sinkW - (basins - 1) * 0.15) / basins
    for (let i = 0; i < basins; i += 1) {
      const bx = dishX0 + 0.3 + i * (bw + 0.15)
      dish.push(box(bx, bx + bw, 2.9, 2.96, dishZ0 + 0.4, kz1 - 0.4, 'grate'))
    }
  }
  add('dish', 0.5, dish, ghost)

  // Middle of the kitchen: alternating prep-table and dry-storage rows, as depth allows.
  const rowLimit = dishZ0 - 3
  for (let i = 0; i < 5; i += 1) {
    const rz0 = midZ0 + i * 6
    const rz1 = rz0 + 2.5
    if (rz1 > rowLimit) break
    const px0 = rz0 < walkZ1 + 0.5 ? walkX1 + 3 : kx0 + 1
    const px1 = kx1 - 1
    if (px1 - px0 < 4) continue
    const rowDelay = 0.38 + i * 0.05
    if (i % 2 === 0) {
      const n = Math.max(1, Math.round((px1 - px0) / 6.5))
      const tw = (px1 - px0 - (n - 1) * 1.2) / n
      for (let j = 0; j < n; j += 1) {
        const x0 = px0 + j * (tw + 1.2)
        const x1 = x0 + tw
        add(
          `prep-${i}-${j}`,
          rowDelay + j * 0.02,
          [
            box(x0, x1, 2.85, 3.0, rz0, rz1, 'steelLight'),
            box(x0 + 0.15, x1 - 0.15, 0.55, 0.65, rz0 + 0.15, rz1 - 0.15, 'steel'),
            box(x0 + 0.1, x0 + 0.3, 0, 2.85, rz0 + 0.15, rz1 - 0.15, 'steel'),
            box(x1 - 0.3, x1 - 0.1, 0, 2.85, rz0 + 0.15, rz1 - 0.15, 'steel'),
          ],
          ghost,
        )
      }
    } else {
      const n = Math.min(5, Math.floor((px1 - px0 + 0.6) / 4.6))
      const sz0 = rz0 + 0.35
      const sz1 = rz0 + 2.15
      for (let j = 0; j < n; j += 1) {
        const x0 = px0 + j * 4.6
        const x1 = x0 + 4
        const shelf: Part[] = [
          box(x0, x0 + 0.15, 0, 6, sz0, sz1, 'steelDark'),
          box(x1 - 0.15, x1, 0, 6, sz0, sz1, 'steelDark'),
        ]
        for (const y of [0.6, 3.0, 5.4]) shelf.push(box(x0 + 0.15, x1 - 0.15, y, y + 0.12, sz0, sz1, 'steel'))
        add(`shelf-${i}-${j}`, rowDelay + j * 0.02, shelf, ghost)
      }
    }
  }
  labels.push({
    id: 'kitchen',
    text: ghost ? 'Kitchen · to be built' : 'Kitchen · installed',
    pos: [(kx0 + kx1) / 2, 13, (kz0 + kz1) / 2],
    delay: 0.85,
  })

  /* ---- Service zone ---- */
  if (isFS) {
    const pcx = (kx0 + kx1) / 2
    const pw = clamp(Kw * 0.4, 5, 9)
    add('pass', 0.5, [
      box(pcx - pw / 2, pcx + pw / 2, 0, 3.4, zK + 0.2, zK + 1.5, 'steel'),
      box(pcx - pw / 2 - 0.1, pcx + pw / 2 + 0.1, 3.4, 3.5, zK + 0.15, zK + 1.6, 'steelLight'),
      box(pcx - pw / 2 + 0.1, pcx - pw / 2 + 0.25, 3.5, 5.1, zK + 0.75, zK + 0.95, 'steelDark'),
      box(pcx + pw / 2 - 0.25, pcx + pw / 2 - 0.1, 3.5, 5.1, zK + 0.75, zK + 0.95, 'steelDark'),
      box(pcx - pw / 2, pcx + pw / 2, 5.1, 5.32, zK + 0.45, zK + 1.25, 'amber'),
    ])
    add('station', 0.54, [
      box(xL + T + 0.8, xL + T + 4.4, 0, 3.4, zK + 0.5, zK + 2.5, 'counter'),
      box(xL + T + 0.7, xL + T + 4.5, 3.4, 3.52, zK + 0.4, zK + 2.6, 'woodDark'),
      box(xL + T + 1.6, xL + T + 2.5, 3.52, 4.25, zK + 1.3, zK + 1.5, 'screen'),
    ])
    labels.push({ id: 'service', text: 'Service', pos: [pcx, 9, zK + 2.2], delay: 0.85 })
    // host stand just inside the door
    const hx = doorX0 - 2.2
    const hz = zF - 4
    add('host', 0.55, [
      box(hx - 0.9, hx + 0.9, 0, 3.6, hz - 0.6, hz + 0.6, 'wood'),
      prim('cyl', hx + 0.45, 3.6, hz, 0.35, 0.7, 'amber'),
    ])
  } else {
    const cx0 = xL + T + 1.2
    const cx1 = xC - 1
    const cz0 = zS - 2.8
    const cz1 = zS - 0.4
    const counter: Part[] = [
      box(cx0, cx1, 0, 3.3, cz0, cz1, 'counter'),
      box(cx0 - 0.1, cx1 + 0.1, 3.3, 3.45, cz0 - 0.1, cz1 + 0.15, 'wood'),
      box(cx0, cx1, 0.22, 0.32, cz1, cz1 + 0.06, 'amber'),
      box(cx1 - 2.45, cx1 - 1.55, 3.45, 4.25, cz0 + 1.2, cz0 + 1.4, 'screen'),
      box(cx1 - 5.45, cx1 - 4.55, 3.45, 4.25, cz0 + 1.2, cz0 + 1.4, 'screen'),
    ]
    if (!isQS) {
      // fast-casual make line sneeze guard
      counter.push(box(cx0 + 1, Math.min(cx0 + 7, cx1 - 6.5), 3.45, 4.6, cz0 + 0.4, cz1 - 0.2, 'glass'))
    }
    add('counter', 0.5, counter)
    const mw = clamp((cx1 - cx0) * 0.6, 6, 14)
    const mcx = (cx0 + cx1) / 2
    const board: Part[] = [
      box(mcx - mw * 0.38 - 0.1, mcx - mw * 0.38 + 0.1, PART_H, 5.6, zK - 0.1, zK + 0.1, 'steelDark'),
      box(mcx + mw * 0.38 - 0.1, mcx + mw * 0.38 + 0.1, PART_H, 5.6, zK - 0.1, zK + 0.1, 'steelDark'),
      box(mcx - mw / 2, mcx + mw / 2, 5.6, 8.4, zK + 0.1, zK + 0.32, 'menu'),
      box(mcx - mw / 2 + 0.6, mcx + mw / 2 - 0.6, 7.75, 7.92, zK + 0.32, zK + 0.38, 'ember'),
    ]
    const menuLines: Array<[number, number]> = [
      [7.05, 0.8],
      [6.55, 0.62],
      [6.05, 0.72],
    ]
    for (const [y, f] of menuLines) {
      board.push(box(mcx - mw / 2 + 0.6, mcx - mw / 2 + 0.6 + (mw - 1.2) * f, y, y + 0.12, zK + 0.32, zK + 0.37, 'amber'))
    }
    add('menu', 0.56, board)
    labels.push({ id: 'counter', text: 'Order counter', pos: [mcx, 10.2, zK + 2], delay: 0.85 })
    reserved.push({ x0: cx1 - 8, x1: xR, z0: zS, z1: zS + 5 }) // queue
  }

  /* ---- Bar along the left wall ---- */
  let barRect: Rect | null = null
  if (spec.hasBar) {
    const bx = xL + T
    const bz0 = zS + 1
    const Lb = clamp(Math.min(Dd * 0.6, Dd - 5.5), 4, 30)
    const bz1 = bz0 + Lb
    add('bar', 0.55, [
      box(bx, bx + 1.3, 0, 3.0, bz0, bz1, 'woodDark'),
      box(bx + 0.1, bx + 0.6, 3.0, 3.1, bz0 + 0.3, bz1 - 0.3, 'amber'),
      box(bx + 3.9, bx + 5.4, 0, 3.4, bz0, bz1, 'woodDark'),
      box(bx + 3.7, bx + 5.8, 3.4, 3.58, bz0 - 0.2, bz1 + 0.2, 'wood'),
      box(bx + 5.55, bx + 5.7, 0.55, 0.68, bz0 + 0.2, bz1 - 0.2, 'amber'),
    ])
    const n = Math.max(1, Math.floor(Lb / 2.2))
    for (let i = 0; i < n; i += 1) {
      addStool(bx + 6.7, bz0 + (Lb * (i + 0.5)) / n, 2.45, 0.6 + (0.2 * i) / Math.max(1, n - 1))
    }
    barRect = { x0: xL, x1: bx + 7.6, z0: bz0 - 1, z1: bz1 + 1.2 }
    reserved.push(barRect)
    labels.push({ id: 'bar', text: `Bar · ${n} stools`, pos: [bx + 3, 6.5, (bz0 + bz1) / 2], delay: 0.9 })
  }

  /* ---- Quick service: counter seating along the window ---- */
  let windowSeats = 0
  let windowCounter = false
  if (isQS) {
    const wx0 = barRect ? barRect.x1 + 0.4 : xL + T + 0.6
    const wx1 = doorX0 - 1.4
    if (wx1 - wx0 >= 4) {
      add('window-bar', 0.58, [
        box(wx0, wx1, 3.3, 3.45, zF - 2.0, zF - 0.45, 'wood'),
        box(wx0, wx1, 0, 3.3, zF - 0.75, zF - 0.45, 'counter'),
      ])
      const maxStools = Math.floor((wx1 - wx0) / 2.1)
      windowSeats = Math.min(seatsReq, maxStools)
      for (let i = 0; i < windowSeats; i += 1) {
        const slot = Math.floor(((i + 0.5) * maxStools) / windowSeats)
        const x = wx0 + ((wx1 - wx0) * (slot + 0.5)) / maxStools
        addStool(x, zF - 2.85, 2.3, 0.62 + (0.18 * i) / Math.max(1, windowSeats - 1))
      }
      reserved.push({ x0: wx0 - 0.3, x1: wx1 + 0.3, z0: zF - 4.3, z1: zF })
      windowCounter = true
    }
  }

  /* ---- Dining tables on a grid ---- */
  reserved.push({ x0: doorX0 - 3.4, x1: xR, z0: zF - 6.5, z1: zF }) // entry
  const rx0 = xL + T + 0.2
  const rx1 = xR - 4 // main aisle on the door side, leading to the restroom corridor
  const rz0 = zS + 0.5
  const rz1 = windowCounter ? zF - 4.3 : zF - 0.9
  const foot = fmt.t4 + 2 * (fmt.gap + fmt.chair)
  // Grid areas: the whole dining room, or (with a bar) the strip beside the bar plus the room in front of it.
  const areas: Rect[] = []
  if (barRect) {
    areas.push({ x0: barRect.x1, x1: rx1, z0: rz0, z1: Math.min(barRect.z1, rz1) })
    if (rz1 > barRect.z1) areas.push({ x0: rx0, x1: rx1, z0: barRect.z1, z1: rz1 })
  } else {
    areas.push({ x0: rx0, x1: rx1, z0: rz0, z1: rz1 })
  }
  const slots: Array<[number, number]> = []
  for (const a of areas) {
    const cols = fitCount(a.x1 - a.x0, fmt.mod, foot)
    const rows = fitCount(a.z1 - a.z0, fmt.mod, foot)
    if (cols === 0 || rows === 0) continue
    const mx = Math.min((a.x1 - a.x0) / cols, fmt.mod * 1.3)
    const mz = Math.min((a.z1 - a.z0) / rows, fmt.mod * 1.3)
    const gx0 = (a.x0 + a.x1) / 2 - (cols * mx) / 2
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const x = gx0 + (c + 0.5) * mx
        const z = a.z1 - foot / 2 - 0.1 - r * mz // rows packed toward the window
        const fp: Rect = { x0: x - foot / 2, x1: x + foot / 2, z0: z - foot / 2, z1: z + foot / 2 }
        if (!reserved.some((rr) => overlaps(fp, rr))) slots.push([x, z])
      }
    }
  }
  slots.sort((p, q) => q[1] - p[1] || p[0] - q[0]) // front to back, left to right
  const tableSeatsReq = seatsReq - windowSeats
  const plan = planTables(tableSeatsReq, slots.length, fmt.avg)
  const nTables = plan.n4 + plan.n2
  const tableSeats = Math.min(tableSeatsReq, plan.capacity)
  type ChairSpot = { x: number; z: number; dx: number; dz: number; delay: number }
  const spots: ChairSpot[] = []
  for (let i = 0; i < nTables; i += 1) {
    const [x, z] = slots[Math.floor(((i + 0.5) * slots.length) / nTables)]
    const two = Math.floor(((i + 1) * plan.n2) / nTables) - Math.floor((i * plan.n2) / nTables) === 1
    const size = two ? fmt.t2 : fmt.t4
    const delay = 0.6 + (0.18 * i) / Math.max(1, nTables - 1)
    tableTops.push({ x, y: fmt.tableH - 0.12, z, sx: size, sy: 0.12, sz: size, delay })
    tableBases.push({ x, y: 0, z, sx: 0.4, sy: fmt.tableH - 0.12, sz: 0.4, delay })
    const off = size / 2 + fmt.gap + fmt.chair / 2
    const dirs: Array<[number, number]> = two
      ? [
          [0, 1],
          [0, -1],
        ]
      : [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ]
    for (const [dx, dz] of dirs) spots.push({ x: x + dx * off, z: z + dz * off, dx, dz, delay: delay + 0.05 })
  }
  spots.length = Math.max(0, spots.length - (plan.capacity - tableSeats))
  const ch = fmt.chair
  for (const s of spots) {
    chairs.push({ x: s.x, y: 0, z: s.z, sx: ch, sy: 1.5, sz: ch, delay: s.delay })
    chairBacks.push({
      x: s.x + s.dx * (ch / 2 - 0.09),
      y: 1.5,
      z: s.z + s.dz * (ch / 2 - 0.09),
      sx: s.dx === 0 ? ch : 0.18,
      sy: 1.5,
      sz: s.dz === 0 ? ch : 0.18,
      delay: s.delay,
    })
  }
  const placed = windowSeats + tableSeats
  labels.push({
    id: 'dining',
    text: `Dining · ${placed}${placed < seatsReq ? ` of ${seatsReq}` : ''} seats`,
    pos: [(rx0 + rx1) / 2, 8.5, (zS + zF) / 2],
    delay: 0.85,
  })

  /* ---- Floor grid, dimension lines, labels ---- */
  const grid: number[] = []
  const gy = 0.06
  for (let x = Math.ceil((xL + T) / 5) * 5; x < xR - T; x += 5) grid.push(x, gy, zR + T, x, gy, zF - 0.4)
  for (let z = Math.ceil((zR + T) / 5) * 5; z < zF - 0.4; z += 5) grid.push(xL + T, gy, z, xR - T, gy, z)
  const dy = -0.26
  const dimZ = zF + SIDEWALK - 1.4
  const dimX = xL - 1.6
  const dims = new Float32Array([
    xL, dy, dimZ, xR, dy, dimZ,
    xL, dy, dimZ - 0.7, xL, dy, dimZ + 0.7,
    xR, dy, dimZ - 0.7, xR, dy, dimZ + 0.7,
    dimX, dy, zR, dimX, dy, zF,
    dimX - 0.7, dy, zR, dimX + 0.7, dy, zR,
    dimX - 0.7, dy, zF, dimX + 0.7, dy, zF,
  ])
  const dimText = `${Math.round(W)} ft × ${Math.round(D)} ft · ${Math.round(sqft).toLocaleString('en-US')} sq ft`
  labels.push({ id: 'dims', text: dimText, pos: [0, 0.6, dimZ], delay: 0.35 })

  const radius = Math.hypot(W / 2 + 1, (D + SIDEWALK + 0.3) / 2)
  const summary =
    `3D storefront diorama: ${dimText}, ${FORMAT_NAME[spec.format]} ${spec.cuisine.replace('_', ' ')}, ` +
    `${placed} dining seats${spec.hasBar ? ', bar' : ''}, ` +
    `${ghost ? 'vacant shell (kitchen to be built)' : 'second-generation kitchen installed'}`

  return {
    scale: FIT_R / radius,
    centerZ: (zR - 0.3 + zF + SIDEWALK) / 2,
    ghost,
    summary,
    groups,
    tableTops,
    tableBases,
    chairs,
    chairBacks,
    stoolSeats,
    stoolPosts,
    labels,
    grid: new Float32Array(grid),
    dims,
    hoodLight: [(lx0 + lx1) / 2, 5.6, kz0 + 2.6],
    signLight: [0, 9.4, zF + 3.5],
    diningLight: [(rx0 + rx1) / 2, 9, (zS + zF) / 2],
  }
}

/* ------------------------------------------------------------------ */
/* Animated building blocks                                            */
/* ------------------------------------------------------------------ */

function buildProgress(t: number, delay: number) {
  const p = clamp((t - delay) / DUR, 0, 1)
  return 1 - (1 - p) ** 3
}

/** Rises out of the slab and grows in height after `delay` seconds (clock starts on mount). */
function Build({ delay, children }: { delay: number; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  const start = useRef<number | null>(null)
  const done = useRef(false)
  useFrame(({ clock }) => {
    const g = ref.current
    if (!g || done.current) return
    const now = clock.elapsedTime
    if (start.current === null) start.current = now
    const e = buildProgress(now - start.current, delay)
    g.visible = e > 0
    g.position.y = -(1 - e) * RISE
    g.scale.y = Math.max(e, 1e-4)
    done.current = e >= 1
  })
  return (
    <group ref={ref} visible={false}>
      {children}
    </group>
  )
}

const TMP_M = new THREE.Matrix4()
const TMP_P = new THREE.Vector3()
const TMP_S = new THREE.Vector3()
const NO_ROT = new THREE.Quaternion()

/** One instanced mesh for many small repeated items, each with its own build-in delay. */
function AnimatedInstances({ items, shape, material }: { items: Inst[]; shape: Shape; material: THREE.Material }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const start = useRef<number | null>(null)
  const done = useRef(false)
  useFrame(({ clock }) => {
    const mesh = ref.current
    if (!mesh || done.current) return
    const now = clock.elapsedTime
    if (start.current === null) start.current = now
    const t = now - start.current
    let finished = true
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      const e = buildProgress(t, it.delay)
      if (e < 1) finished = false
      TMP_P.set(it.x, it.y - (1 - e) * RISE, it.z)
      TMP_S.set(it.sx, it.sy * Math.max(e, 1e-4), it.sz)
      mesh.setMatrixAt(i, TMP_M.compose(TMP_P, NO_ROT, TMP_S))
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.visible = true
    done.current = finished
  })
  if (items.length === 0) return null
  return <instancedMesh ref={ref} args={[GEO[shape], material, items.length]} frustumCulled={false} visible={false} />
}

function Prim({ part, ghost }: { part: Part; ghost: boolean }) {
  return (
    <mesh geometry={GEO[part.shape]} material={ghost ? MAT.ghost : MAT[part.mat]} position={part.pos} scale={part.size}>
      {ghost ? <lineSegments geometry={EDGES[part.shape]} material={GHOST_EDGE} /> : null}
    </mesh>
  )
}

/**
 * Labels are plain DOM nodes laid over the canvas (no extra React roots), positioned every frame
 * by projecting their model-space anchor through the camera.
 */
function LabelProjector({ layout, nodes }: { layout: Layout; nodes: React.RefObject<(HTMLDivElement | null)[]> }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    const s = layout.scale
    layout.labels.forEach((l, i) => {
      const el = nodes.current[i]
      if (!el) return
      v.set(l.pos[0] * s, l.pos[1] * s, (l.pos[2] - layout.centerZ) * s).project(camera)
      const x = (v.x * 0.5 + 0.5) * size.width
      const y = (-v.y * 0.5 + 0.5) * size.height
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`
      el.style.visibility = v.z < 1 ? 'visible' : 'hidden'
    })
  })
  return null
}

/** Everything that builds in; remounted (via key) whenever the spec changes. */
function Diorama({ layout }: { layout: Layout }) {
  return (
    <>
      <Build delay={0}>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[layout.grid, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#2a3345" transparent opacity={0.55} />
        </lineSegments>
      </Build>
      <Build delay={0.3}>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[layout.dims, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#ffb248" transparent opacity={0.45} />
        </lineSegments>
      </Build>
      {layout.groups.map((g) => (
        <Build key={g.id} delay={g.delay}>
          {g.parts.map((p, i) => (
            <Prim key={`${g.id}-${i}`} part={p} ghost={g.ghost} />
          ))}
        </Build>
      ))}
      <AnimatedInstances items={layout.tableTops} shape="box" material={MAT.wood} />
      <AnimatedInstances items={layout.tableBases} shape="box" material={MAT.tableBase} />
      <AnimatedInstances items={layout.chairs} shape="box" material={MAT.chair} />
      <AnimatedInstances items={layout.chairBacks} shape="box" material={MAT.chair} />
      <AnimatedInstances items={layout.stoolPosts} shape="cyl" material={MAT.steelDark} />
      <AnimatedInstances items={layout.stoolSeats} shape="cyl" material={MAT.stoolSeat} />
    </>
  )
}

/** Keeps the camera distance such that the (constant-radius) model fits the canvas aspect. */
function CameraRig() {
  const camera = useThree((st) => st.camera)
  const width = useThree((st) => st.size.width)
  const height = useThree((st) => st.size.height)
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera) || width === 0 || height === 0) return
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const tanH = tanV * (width / height)
    const dist = Math.max(FIT_V / tanV, (FIT_R * 1.08) / tanH)
    const target = new THREE.Vector3(...TARGET)
    const offset = camera.position.clone().sub(target).setLength(dist)
    camera.position.copy(target).add(offset)
  }, [camera, width, height])
  return null
}

function Scene({ layout, buildKey, labelNodes }: { layout: Layout; buildKey: string; labelNodes: React.RefObject<(HTMLDivElement | null)[]> }) {
  const s = layout.scale
  const k = 25 * s * s // keeps point-light brightness constant across model scales
  return (
    <>
      <hemisphereLight args={['#39436a', '#07090d', 0.6]} />
      <ambientLight color="#b9c1e0" intensity={0.16} />
      <directionalLight color="#ffd6a8" intensity={2.1} position={[6, 11, 7]} />
      <directionalLight color="#6f7dff" intensity={0.9} position={[-9, 6, -7]} />
      <group scale={s} position={[0, 0, -layout.centerZ * s]}>
        <Diorama key={buildKey} layout={layout} />
        <pointLight
          position={layout.hoodLight}
          color={layout.ghost ? '#6f7dff' : '#ffb248'}
          intensity={(layout.ghost ? 0.6 : 2.6) * k}
          distance={16 * s}
          decay={2}
        />
        <pointLight position={layout.signLight} color="#ffb248" intensity={1.8 * k} distance={18 * s} decay={2} />
        <pointLight position={layout.diningLight} color="#ffd6a8" intensity={1.4 * k} distance={34 * s} decay={2} />
      </group>
      <ContactShadows
        position={[0, -1.02 * s, 0]}
        scale={FIT_R * 2 + 2.5}
        far={2.2}
        blur={2.6}
        opacity={0.6}
        resolution={256}
        color="#000000"
      />
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        autoRotate
        autoRotateSpeed={0.6}
        minPolarAngle={0.55}
        maxPolarAngle={0.98}
        dampingFactor={0.08}
        target={TARGET}
      />
      <CameraRig />
      <LabelProjector layout={layout} nodes={labelNodes} />
    </>
  )
}

export default function Storefront3D({ spec, height = 420 }: { spec: StorefrontSpec; height?: number }): React.JSX.Element {
  const { sqft, format, cuisine, seats, hasBar, storefront } = spec
  const layout = useMemo(
    () => computeLayout({ sqft, format, cuisine, seats, hasBar, storefront }),
    [sqft, format, cuisine, seats, hasBar, storefront],
  )
  const buildKey = `${sqft}|${format}|${cuisine}|${seats}|${hasBar ? 1 : 0}|${storefront}`
  const labelNodes = useRef<(HTMLDivElement | null)[]>([])
  return (
    <div style={{ width: '100%', height, position: 'relative', cursor: 'grab' }} role="img" aria-label={layout.summary}>
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={{ fov: CAM_FOV, near: 0.5, far: 120, position: INITIAL_CAMERA }}
        style={{ background: 'transparent' }}
      >
        <Scene layout={layout} buildKey={buildKey} labelNodes={labelNodes} />
      </Canvas>
      <div key={buildKey} style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        {layout.labels.map((l, i) => (
          <div
            key={l.id}
            ref={(el) => {
              labelNodes.current[i] = el
            }}
            style={{ ...LABEL_STYLE, animation: `sf3d-label 420ms ease ${l.delay}s both` }}
          >
            {l.text}
          </div>
        ))}
      </div>
      <style>{'@keyframes sf3d-label { from { opacity: 0 } to { opacity: 1 } }'}</style>
    </div>
  )
}
