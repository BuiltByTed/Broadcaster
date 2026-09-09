import { useEffect, useRef } from 'react'

export default function StaticNoise({ active }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!active) return
    const canvas = ref.current
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    let frame, pixels
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const draw = () => {
      if (document.hidden || !pixels) return
      for (let i = 0; i < pixels.length; i++) {
        const level = Math.floor(Math.random() * 180) + 25
        pixels[i] = (255 << 24) | (level << 16) | (level << 8) | level
      }
      ctx.putImageData(frame, 0, 0)
    }
    const resize = () => {
      const box = canvas.getBoundingClientRect()
      // A fresh raster at the actual TV ratio keeps noise grains square.
      canvas.width = Math.max(1, Math.round(box.width / 3))
      canvas.height = Math.max(1, Math.round(box.height / 3))
      frame = ctx.createImageData(canvas.width, canvas.height)
      pixels = new Uint32Array(frame.data.buffer)
      draw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    const timer = reducedMotion ? null : setInterval(draw, 80)
    return () => { clearInterval(timer); observer.disconnect() }
  }, [active])
  return <canvas ref={ref} width="192" height="108" className="static-noise" hidden={!active} aria-hidden="true" />
}
