type RGBA = [number, number, number, number]

// Diverging scale (same family as BrewGap): saturated -> cool indigo, balanced -> slate, unmet demand -> amber/ember.
const COOL: [number, number, number] = [92, 110, 255]
const MID: [number, number, number] = [44, 50, 66]
const WARM: [number, number, number] = [255, 178, 72]
const HOT: [number, number, number] = [255, 92, 56]

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

export function gapColor(gap: number, alpha = 220, span = 3): RGBA {
  if (gap >= 0) {
    const t = Math.min(gap / span, 1)
    const c = t < 0.6 ? mix(MID, WARM, t / 0.6) : mix(WARM, HOT, (t - 0.6) / 0.4)
    return [c[0], c[1], c[2], alpha]
  }
  const t = Math.min(-gap / span, 1)
  const c = mix(MID, COOL, t)
  return [c[0], c[1], c[2], alpha]
}

export const legendStops = (span = 3) =>
  [-1, -0.5, 0, 0.33, 0.66, 1].map((k) => {
    const [r, g, b] = gapColor(k * span, 255, span)
    return `rgb(${r},${g},${b})`
  })

/** Payback months -> color: fast mint, median amber, slow ember, never red. */
export function paybackColor(m: number, alpha = 1): string {
  if (!Number.isFinite(m)) return `rgba(255,84,104,${alpha})`
  const stops: [number, [number, number, number]][] = [
    [0, [124, 240, 197]], [18, [124, 240, 197]], [30, [255, 208, 138]], [42, [255, 178, 72]], [56, [255, 92, 56]], [72, [255, 84, 104]],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (m <= stops[i][0]) {
      const [m0, c0] = stops[i - 1]
      const [m1, c1] = stops[i]
      const t = (m - m0) / (m1 - m0 || 1)
      const c = mix(c0, c1, t)
      return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`
    }
  }
  return `rgba(255,84,104,${alpha})`
}

export const RANK_COLORS: [number, number, number][] = [
  [255, 208, 138],
  [124, 240, 197],
  [150, 170, 255],
]
