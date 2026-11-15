import { useEffect, useRef, useState, type RefObject } from 'react'
import { reducedMotion } from './format'

// ---------- in-view ----------
export function useInView<T extends Element>(opts: { once?: boolean; threshold?: number; root?: RefObject<Element | null> } = {}) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  const { once = true, threshold = 0.25, root } = opts
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true)
          if (once) io.disconnect()
        } else if (!once) setInView(false)
      },
      { threshold, root: root?.current ?? null },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [once, threshold, root])
  return [ref, inView] as const
}

// ---------- animated numbers ----------
export function useTween(target: number, active: boolean, duration = 1100) {
  const [v, setV] = useState(active && reducedMotion() ? target : 0)
  const from = useRef(0)
  useEffect(() => {
    if (!active) return
    if (reducedMotion() || !Number.isFinite(target)) {
      setV(target)
      return
    }
    const start = performance.now()
    const v0 = from.current
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const e = 1 - Math.pow(1 - t, 3)
      const cur = v0 + (target - v0) * e
      setV(cur)
      from.current = cur
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, active, duration])
  return v
}
