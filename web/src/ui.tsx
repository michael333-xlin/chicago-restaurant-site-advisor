import type { ReactNode } from 'react'
import { useInView, useTween } from './hooks'

export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.12 })
  return (
    <div ref={ref} className={`reveal ${inView ? 'in' : ''} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

export function CountUp({ value, format, duration }: { value: number; format: (v: number) => string; duration?: number }) {
  const [ref, inView] = useInView<HTMLSpanElement>()
  const v = useTween(value, inView, duration)
  return <span ref={ref}>{Number.isFinite(value) ? format(v) : format(value)}</span>
}
