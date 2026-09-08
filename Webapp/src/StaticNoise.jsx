import { useEffect, useRef } from 'react'

export default function StaticNoise({ active }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!active) return
    const canvas = ref.current
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    const frame = ctx.createImageData(192, 108)
    const pixels = new Uint32Array(frame.data.buffer)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const draw = () => {
      if (document.hidden) return
      for (let i = 0; i < pixels.length; i++) {
        const level = Math.floor(Math.random() * 180) + 25
        pixels[i] = (255 << 24) | (level << 16) | (level << 8) | level
      }
      ctx.putImageData(frame, 0, 0)
    }
    draw()
    const timer = reducedMotion ? null : setInterval(draw, 80)
    return () => clearInterval(timer)
  }, [active])
  return <canvas ref={ref} width="192" height="108" className="static-noise" hidden={!active} aria-hidden="true" />
}
