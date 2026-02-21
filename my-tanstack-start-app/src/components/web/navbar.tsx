import { useEffect, useMemo, useRef } from 'react'

/**
 * LorenzAttractorBackground (image background version)
 * - Uses a real universe image from /public/universe.png
 * - No fixed starfield
 * - Canvas renderScale + DPR cap
 * - Pre-rendered orb sprites (no per-particle gradients)
 * - Cheap soft veil + cheap tiled grain overlay
 *
 * MOD:
 * - Runs at 600% speed for the first minute, then returns to normal speed.
 *
 * MOD 2:
 * - Camera orbit: slowly rotates in a spherical path around the attractor,
 *   so you observe it from multiple viewpoints over time.
 *
 * MOD 3:
 * - Gentle background zoom: 30s zoom-in, then 30s zoom-out at same speed (ping-pong).
 * - Implemented via GPU transform scale on the background layer (best quality for a CSS background).
 */
export default function LorenzAttractorBackground({
  className = '',
  particleCount = 1100,

  // Lorenz parameters
  sigma = 10,
  rho = 28,
  beta = 8 / 3,

  // Integration
  dt = 0.0026,
  stepsPerFrame = 1,

  // Attractor visuals
  trail = 0.18,
  pointSize = 2.6,
  opacity = 0.85,

  // Background image
  backgroundImageSrc = '/universe.png',
  backgroundImageOpacity = 0.9,
  backgroundImageScale = 1.06,
  backgroundImagePosition = '50% 50%',
  backgroundImageBrightness = 0.92,
  backgroundImageContrast = 1.08,
  backgroundImageSaturate = 1.05,

  // Fallback color (behind image)
  backgroundColor = '#020617',
  backgroundOpacity = 1,

  // Performance smoothing
  renderScale = 0.82,
  dprMax = 1.25,

  // Velvet overlays
  velvetEnabled = true,
  veilOpacity = 1,
  grainOpacity = 0.06,

  // "Activation" shaping: maps speed -> alpha
  activation = (v: number) => {
    const k = 5
    const x = Math.max(0, Math.min(1, v))
    return 1 / (1 + Math.exp(-k * (x - 0.5)))
  },
}: {
  className?: string
  particleCount?: number
  sigma?: number
  rho?: number
  beta?: number
  dt?: number
  stepsPerFrame?: number
  trail?: number
  pointSize?: number
  opacity?: number

  backgroundImageSrc?: string
  backgroundImageOpacity?: number
  backgroundImageScale?: number
  backgroundImagePosition?: string
  backgroundImageBrightness?: number
  backgroundImageContrast?: number
  backgroundImageSaturate?: number

  backgroundColor?: string
  backgroundOpacity?: number

  renderScale?: number
  dprMax?: number

  velvetEnabled?: boolean
  veilOpacity?: number
  grainOpacity?: number

  activation?: (normalizedSpeed01: number) => number
}) {
  const attractorCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const bgRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(performance.now())

  // Inline SVG grain (tiny + seamless, cheap)
  const grainDataUri = useMemo(() => {
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">
  <filter id="n">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="
      1 0 0 0 0
      0 1 0 0 0
      0 0 1 0 0
      0 0 0 0.35 0"/>
  </filter>
  <rect width="160" height="160" filter="url(#n)" opacity="1"/>
</svg>`.trim()
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  }, [])

  // Seeds
  const seeds = useMemo(() => {
    const pts: Array<{ x: number; y: number; z: number }> = []
    const base = { x: 0.1, y: 0, z: 0 }
    for (let i = 0; i < particleCount; i++) {
      const j = 0.004
      const x = base.x + (Math.random() - 0.5) * j
      const y = base.y + (Math.random() - 0.5) * j
      const z = base.z + (Math.random() - 0.5) * j
      pts.push({ x, y, z })
    }
    return pts
  }, [particleCount])

  useEffect(() => {
    const canvas = attractorCanvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const dpr = Math.max(1, Math.min(dprMax, window.devicePixelRatio || 1))
    const rs = Math.max(0.5, Math.min(1, renderScale))

    let w = 0
    let h = 0
    let rw = 0
    let rh = 0

    const center = { x: 0, y: 0 }

    // running bounds for auto-scale
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity

    // Camera rotation state (updated per-frame)
    let cy = 1,
      sy = 0,
      cp = 1,
      sp = 0

    const ORB_BUCKETS = 16

    const deriv = (x: number, y: number, z: number) => {
      const dx = sigma * (y - x)
      const dy = x * (rho - z) - y
      const dz = x * y - beta * z
      return { dx, dy, dz }
    }

    const rk4 = (p: { x: number; y: number; z: number }, hStep: number) => {
      const k1 = deriv(p.x, p.y, p.z)
      const k2 = deriv(
        p.x + (hStep * k1.dx) / 2,
        p.y + (hStep * k1.dy) / 2,
        p.z + (hStep * k1.dz) / 2,
      )
      const k3 = deriv(
        p.x + (hStep * k2.dx) / 2,
        p.y + (hStep * k2.dy) / 2,
        p.z + (hStep * k2.dz) / 2,
      )
      const k4 = deriv(
        p.x + hStep * k3.dx,
        p.y + hStep * k3.dy,
        p.z + hStep * k3.dz,
      )

      p.x += (hStep / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx)
      p.y += (hStep / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy)
      p.z += (hStep / 6) * (k1.dz + 2 * k2.dz + 2 * k3.dz + k4.dz)
    }

    const makeOrbSprite = (size: number, hue: number) => {
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const g = c.getContext('2d', { alpha: true })
      if (!g) return c
      const r = size / 2
      const grad = g.createRadialGradient(r * 0.72, r * 0.72, r * 0.1, r, r, r)
      grad.addColorStop(0, `hsla(${hue},70%,85%,1)`)
      grad.addColorStop(0.55, `hsla(${hue},70%,55%,0.9)`)
      grad.addColorStop(1, `hsla(${hue},70%,55%,0)`)
      g.fillStyle = grad
      g.beginPath()
      g.arc(r, r, r, 0, Math.PI * 2)
      g.fill()
      return c
    }

    // sprite cache
    const orbSprites = Array.from({ length: ORB_BUCKETS }, (_, i) =>
      makeOrbSprite(64, 195 + (45 * i) / (ORB_BUCKETS - 1)),
    )

    const resize = () => {
      w = Math.floor(window.innerWidth)
      h = Math.floor(window.innerHeight)

      rw = Math.max(1, Math.floor(w * dpr * rs))
      rh = Math.max(1, Math.floor(h * dpr * rs))

      canvas.width = rw
      canvas.height = rh
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`

      // map logical screen coords onto smaller backbuffer
      ctx.setTransform(rw / w, 0, 0, rh / h, 0, 0)
      ctx.imageSmoothingEnabled = true

      center.x = w / 2
      center.y = h / 2
    }

    const project = (x: number, y: number, z: number) => {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)

      const spanX = Math.max(1e-6, maxX - minX)
      const spanY = Math.max(1e-6, maxY - minY)
      const spanZ = Math.max(1e-6, maxZ - minZ)

      const nx = ((x - (minX + spanX / 2)) / (spanX / 2)) * 0.92
      const ny = ((y - (minY + spanY / 2)) / (spanY / 2)) * 0.92
      const nz = ((z - (minZ + spanZ / 2)) / (spanZ / 2)) * 0.92

      // yaw (Y axis)
      let rx = nx * cy + nz * sy
      let rz = -nx * sy + nz * cy

      // pitch (X axis)
      let ry = ny * cp - rz * sp
      rz = ny * sp + rz * cp

      const s = 1.1 / (2.6 - rz)

      return {
        sx: center.x + rx * s * Math.min(w, h) * 0.42,
        sy: center.y + ry * s * Math.min(w, h) * 0.42,
        depth: rz,
      }
    }

    const fade = () => {
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, trail))})`
      ctx.fillRect(0, 0, w, h)
      ctx.restore()
    }

    // Smoothstep for gentle zoom easing (reduces shimmer)
    const smooth01 = (x: number) => {
      const t = Math.max(0, Math.min(1, x))
      return t * t * (3 - 2 * t)
    }

    resize()
    window.addEventListener('resize', resize)

    ctx.clearRect(0, 0, w, h)

    const baseBgScale = Math.max(1, backgroundImageScale)
    const zoomAmp = 0.04 // subtle (best for preserving perceived quality on cover backgrounds)
    const halfCycle = 30 // seconds in, 30 seconds out

    const animate = () => {
      const now = performance.now()
      const elapsed = now - startTimeRef.current
      const t = elapsed / 1000

      // Background zoom ping-pong: 0->1 over 30s, then 1->0 over 30s
      const cycle = halfCycle * 2
      const u = (t % cycle) / cycle // 0..1
      const phase01 = u < 0.5 ? smooth01(u * 2) : smooth01((1 - u) * 2) // 0..1..0
      const bgScale = baseBgScale + zoomAmp * phase01

      const bgEl = bgRef.current
      if (bgEl) {
        // translateZ(0) helps keep the layer on GPU and reduces wobble
        bgEl.style.transform = `translateZ(0) scale(${bgScale})`
      }

      // Camera orbit (slow spherical): yaw steadily increases, pitch gently oscillates
      const yawBase = 0.55
      const pitchBase = -0.25
      const yawSpeed = 0.12 // rad/s (slow)
      const pitchAmp = 0.28 // radians
      const pitchSpeed = 0.08 // rad/s (slow)

      const yaw = yawBase + t * yawSpeed
      const pitch = pitchBase + Math.sin(t * pitchSpeed) * pitchAmp

      cy = Math.cos(yaw)
      sy = Math.sin(yaw)
      cp = Math.cos(pitch)
      sp = Math.sin(pitch)

      const speedFactor = elapsed < 60_000 ? 6 : 1
      const effectiveDt = dt * speedFactor

      fade()

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.imageSmoothingEnabled = true

      for (let i = 0; i < seeds.length; i++) {
        const p = seeds[i] as { x: number; y: number; z: number }

        for (let s = 0; s < stepsPerFrame; s++) rk4(p, effectiveDt)

        const a = deriv(p.x, p.y, p.z)
        const speed = Math.sqrt(a.dx * a.dx + a.dy * a.dy + a.dz * a.dz)
        const ns = Math.max(0, Math.min(1, speed / 60))
        const act = activation(ns)

        const pos = project(p.x, p.y, p.z)
        const depth01 = Math.max(0, Math.min(1, (pos.depth + 1) / 2))

        const alpha = opacity * (0.35 + 0.65 * act) * (0.22 + 0.78 * depth01)
        const r = Math.max(0.9, (pointSize * (0.85 + 1.35 * depth01)) / 2)

        const bucket = Math.max(
          0,
          Math.min(ORB_BUCKETS - 1, Math.floor(act * (ORB_BUCKETS - 1))),
        )
        const spr = orbSprites[bucket]

        ctx.globalAlpha = alpha
        ctx.drawImage(spr, pos.sx - r, pos.sy - r, r * 2, r * 2)
      }

      ctx.restore()
      ctx.globalAlpha = 1

      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [
    seeds,
    sigma,
    rho,
    beta,
    dt,
    stepsPerFrame,
    trail,
    pointSize,
    opacity,
    activation,
    renderScale,
    dprMax,
    backgroundImageScale,
  ])

  return (
    <div
      className={
        'pointer-events-none fixed inset-0 -z-10 w-screen h-screen overflow-hidden ' +
        className
      }
    >
      {/* Fallback solid backdrop behind the image */}
      <div
        className="absolute inset-0"
        style={{
          backgroundColor,
          opacity: Math.max(0, Math.min(1, backgroundOpacity)),
        }}
      />

      {/* Universe image background */}
      <div
        ref={bgRef}
        className="absolute inset-0"
        style={{
          backgroundImage: `url("${backgroundImageSrc}")`,
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: backgroundImagePosition,
          opacity: Math.max(0, Math.min(1, backgroundImageOpacity)),
          transform: `translateZ(0) scale(${Math.max(1, backgroundImageScale)})`,
          transformOrigin: backgroundImagePosition,
          filter: `brightness(${Math.max(
            0.1,
            backgroundImageBrightness,
          )}) contrast(${Math.max(
            0.1,
            backgroundImageContrast,
          )}) saturate(${Math.max(0.1, backgroundImageSaturate)})`,
          willChange: 'transform',
          backfaceVisibility: 'hidden',
        }}
      />

      {/* Attractor layer */}
      <canvas
        ref={attractorCanvasRef}
        className="absolute inset-0 h-full w-full"
      />

      {/* Cheap velvet veil (NO backdrop-filter) */}
      {velvetEnabled && (
        <div
          className="absolute inset-0"
          style={{
            opacity: Math.max(0, Math.min(1, veilOpacity)),
            background:
              'radial-gradient(1200px 800px at 50% 30%, rgba(255,255,255,0.04), rgba(255,255,255,0) 60%),' +
              'radial-gradient(1000px 700px at 20% 80%, rgba(99,102,241,0.05), rgba(0,0,0,0) 55%)',
          }}
        />
      )}

      {/* Cheap grain (tiled SVG, no blur) */}
      {velvetEnabled && grainOpacity > 0 && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url("${grainDataUri}")`,
            backgroundRepeat: 'repeat',
            opacity: Math.max(0, Math.min(1, grainOpacity)),
            mixBlendMode: 'overlay',
          }}
        />
      )}
    </div>
  )
}

// Example usage component
export function Navbar() {
  return (
    <>
      <nav className="sticky top-0 z-50 backdrop-blur-2xl supports-[backdrop-filter]:bg-white/10">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <img
              src="https://avatars.githubusercontent.com/u/72518640?s=200&v=4"
              alt="Tanstack logo"
              className="size-8"
            />
            <h1 className="px-2 py-1 text-lg font-semibold">Tanstack Start</h1>
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-lg bg-amber-400 px-2 py-1 font-semibold text-white shadow-lg shadow-amber-700/80 transition-colors hover:cursor-pointer hover:bg-amber-500">
              Button
            </button>
          </div>
        </div>
      </nav>

      <LorenzAttractorBackground
        // Put the generated image in:
        // my-tanstack-start-app/public/universe.png
        // and reference it like this:
        backgroundImageSrc="/universe.png"
        backgroundImageOpacity={0.92}
        backgroundImageBrightness={0.9}
        backgroundImageContrast={1.12}
        backgroundImageSaturate={1.06}
        particleCount={1100}
        renderScale={0.82}
        dprMax={1.25}
        velvetEnabled
        grainOpacity={0.06}
      />
    </>
  )
}
