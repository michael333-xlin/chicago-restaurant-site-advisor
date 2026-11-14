// ---------- formatting ----------
export const usd = (v: number) => {
  const a = Math.abs(v)
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${Math.round(a / 1000)}k` : a >= 1000 ? `$${(a / 1000).toFixed(1)}k` : `$${Math.round(a)}`
  return v < 0 ? `−${s}` : s
}
export const usdFull = (v: number) => `${v < 0 ? '−' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`
export const months = (v: number) => (Number.isFinite(v) ? `${Math.round(v)} mo` : '> 72 mo')
export const monthsNum = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : '72+')
export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`
export const num = (v: number) => Math.round(v).toLocaleString('en-US')

export const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
