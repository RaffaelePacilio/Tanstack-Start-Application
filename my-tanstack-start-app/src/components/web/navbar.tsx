import { useEffect, useMemo, useRef } from 'react'

/**
 * LorenzAttractorBackground (performance-friendly "velvet" version)
 * + Camera orbit starts immediately (orbitDelayMs default = 0)
 * + Fixed stars rotate with camera
 * + No warp/moving dots layer
 */
export default function LorenzAttractorBackground({
  className = '',
  particleCount = 1100,

  // Lorenz parameters (classic chaotic set)
  sigma = 10,
  rho = 28,
  beta = 8 / 3,

  // Integration
  dt = 0.0026,
  stepsPerFrame = 1,

  // Attractor visuals
  trail = 0.18, // 0..1 : higher = shorter trails
  pointSize = 2.6,
  opacity = 0.85,

  // Backdrop layer (dark blue space)
  backgroundColor = '#020617',
  backgroundOpacity = 1,
  backgroundClassName = '',

  // Fixed stars (static)
  starsEnabled = true,
  starCount = 650,
  starOpacity = 0.55,
  starSizeMin = 0.6,
  starSizeMax = 1.8,
  starDepth = 3.2,

  // Performance smoothing
  renderScale = 0.82, // 0.6..1 (lower = faster + smoother)
  dprMax = 1.25,

  // Cheap "velvet" overlays
  velvetEnabled = true,
  veilOpacity = 1,
  grainOpacity = 0.06,

  // Camera orbit (STARTS NOW)
  orbitEnabled = true,
  orbitDelayMs = 0,
  orbitSpeed = 0.11, // rad/s
  orbitPitch = -0.25,
  orbitPitchWobble = 0.04, // radians

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

  backgroundColor?: string
  backgroundOpacity?: number
  backgroundClassName?: string

  starsEnabled?: boolean
  starCount?: number
  starOpacity?: number
  starSizeMin?: number
  starSizeMax?: number
  starDepth?: number

  renderScale?: number
  dprMax?: number

  velvetEnabled?: boolean
  veilOpacity?: number
  grainOpacity?: number

  orbitEnabled?: boolean
  orbitDelayMs?: number
  orbitSpeed?: number
  orbitPitch?: number
  orbitPitchWobble?: number

  activation?: (normalizedSpeed01: number) => number
}) {
  const starsCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const attractorCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)

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

  // Blob of nearby initial conditions
  const seeds = useMemo(() => {
    const pts: Array<{
      x: number
      y: number
      z: number
      px: number
      py: number
      pz: number
    }> = []
    const base = { x: 0.1, y: 0, z: 0 }
    for (let i = 0; i < particleCount; i++) {
      const j = 0.004
      const x = base.x + (Math.random() - 0.5) * j
      const y = base.y + (Math.random() - 0.5) * j
      const z = base.z + (Math.random() - 0.5) * j
      pts.push({ x, y, z, px: x, py: y, pz: z })
    }
    return pts
  }, [particleCount])

  // Fixed stars (generated once)
  const stars = useMemo(() => {
    const s: Array<{
      x: number
      y: number
      z: number
      r: number
      a: number
      tint: number
    }> = []
    for (let i = 0; i < starCount; i++) {
      const u = Math.random()
      const v = Math.random()
      const theta = 2 * Math.PI * u
      const phi = Math.acos(2 * v - 1)

      const radius = 1.0 + Math.random() * 1.8
      const x = radius * Math.sin(phi) * Math.cos(theta)
      const y = radius * Math.sin(phi) * Math.sin(theta)
      const z = radius * Math.cos(phi)

      const r =
        starSizeMin + Math.random() * Math.max(0.001, starSizeMax - starSizeMin)
      const a = 0.35 + Math.random() * 0.65
      const tint = 200 + Math.random() * 40
      s.push({ x, y, z, r, a, tint })
    }
    return s
  }, [starCount, starSizeMin, starSizeMax])

  useEffect(() => {
    const starsCanvas = starsCanvasRef.current
    const attractorCanvas = attractorCanvasRef.current
    if (!attractorCanvas) return

    const ctx = attractorCanvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const starsCtx = starsCanvas?.getContext('2d', { alpha: true }) || null

    const dpr = Math.max(1, Math.min(dprMax, window.devicePixelRatio || 1))
    const rs = Math.max(0.5, Math.min(1, renderScale))

    let w = 0
    let h = 0
    let rw = 0
    let rh = 0

    // Camera / projection
    const center = { x: 0, y: 0 }

    // Running bounds for auto-scaling (keeps the attractor framed)
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity

    // Perf time refs
    const startMs = performance.now()

    // --- Sprite caches (fast) ---
    const ORB_BUCKETS = 16
    const STAR_BUCKETS = 8

    const makeOrbSprite = (
      size: number,
      hue: number,
      sat: number,
      light: number,
    ) => {
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const g = c.getContext('2d', { alpha: true })!
      const r = size / 2
      const gx = r * 0.72
      const gy = r * 0.72

      const grad = g.createRadialGradient(gx, gy, r * 0.1, r, r, r)
      grad.addColorStop(
        0,
        `hsla(${hue}, ${sat}%, ${Math.min(98, light + 30)}%, 1)`,
      )
      grad.addColorStop(0.55, `hsla(${hue}, ${sat}%, ${light}%, 0.9)`)
      grad.addColorStop(1, `hsla(${hue}, ${sat}%, ${light}%, 0)`)

      g.fillStyle = grad
      g.beginPath()
      g.arc(r, r, r, 0, Math.PI * 2)
      g.fill()
      return c
    }

    const orbSprites: HTMLCanvasElement[] = Array.from(
      { length: ORB_BUCKETS },
      (_, i) => {
        const hue = 195 + (45 * i) / (ORB_BUCKETS - 1)
        return makeOrbSprite(64, hue, 70, 55)
      },
    )

    const starSprites: HTMLCanvasElement[] = Array.from(
      { length: STAR_BUCKETS },
      (_, i) => {
        const hue = 200 + (40 * i) / (STAR_BUCKETS - 1)
        return makeOrbSprite(32, hue, 30, 92)
      },
    )

    const resize = () => {
      w = Math.floor(window.innerWidth)
      h = Math.floor(window.innerHeight)

      rw = Math.max(1, Math.floor(w * dpr * rs))
      rh = Math.max(1, Math.floor(h * dpr * rs))

      // Attractor canvas (render smaller, display full size)
      attractorCanvas.width = rw
      attractorCanvas.height = rh
      attractorCanvas.style.width = `${w}px`
      attractorCanvas.style.height = `${h}px`

      ctx.setTransform(rw / w, 0, 0, rh / h, 0, 0)
      ctx.imageSmoothingEnabled = true

      // Stars canvas
      if (starsCanvas && starsCtx) {
        starsCanvas.width = rw
        starsCanvas.height = rh
        starsCanvas.style.width = `${w}px`
        starsCanvas.style.height = `${h}px`

        starsCtx.setTransform(rw / w, 0, 0, rh / h, 0, 0)
        starsCtx.imageSmoothingEnabled = true
      }

      center.x = w / 2
      center.y = h / 2
    }

    // Helper: Lorenz derivatives
    const deriv = (x: number, y: number, z: number) => {
      const dx = sigma * (y - x)
      const dy = x * (rho - z) - y
      const dz = x * y - beta * z
      return { dx, dy, dz }
    }

    // RK4 step for stability
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

    // Camera basis (yaw/pitch) computed per-frame
    const getCamera = (nowMs: number) => {
      const baseYaw = 0.55
      const delay = Math.max(0, orbitDelayMs)
      const orbitOn = orbitEnabled && nowMs - startMs >= delay
      const tSec = Math.max(0, (nowMs - startMs - delay) / 1000)

      const yaw = orbitOn ? baseYaw + tSec * orbitSpeed : baseYaw
      const pitch =
        (orbitEnabled ? orbitPitch : -0.25) +
        (orbitOn ? Math.sin(tSec * 0.6) * orbitPitchWobble : 0)

      const cy = Math.cos(yaw)
      const sy = Math.sin(yaw)
      const cp = Math.cos(pitch)
      const sp = Math.sin(pitch)

      return { cy, sy, cp, sp }
    }

    // Project 3D point to screen (attractor: adaptive bounds)
    const projectAttractor = (
      x: number,
      y: number,
      z: number,
      cam: { cy: number; sy: number; cp: number; sp: number },
    ) => {
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

      // rotate Y then X
      let rx = nx * cam.cy + nz * cam.sy
      let rz = -nx * cam.sy + nz * cam.cy
      let ry = ny * cam.cp - rz * cam.sp
      rz = ny * cam.sp + rz * cam.cp

      const perspective = 1.1
      const depth = 2.6
      const s = perspective / (depth - rz)

      return {
        sx: center.x + rx * s * Math.min(w, h) * 0.42,
        sy: center.y + ry * s * Math.min(w, h) * 0.42,
        depth: rz,
      }
    }

    // Project static star point
    const projectStar = (
      x: number,
      y: number,
      z: number,
      cam: { cy: number; sy: number; cp: number; sp: number },
    ) => {
      let rx = x * cam.cy + z * cam.sy
      let rz = -x * cam.sy + z * cam.cy
      let ry = y * cam.cp - rz * cam.sp
      rz = y * cam.sp + rz * cam.cp

      const perspective = 1.0
      const depth = Math.max(1.8, starDepth)
      const s = perspective / (depth - rz)

      return {
        sx: center.x + rx * s * Math.min(w, h) * 0.55,
        sy: center.y + ry * s * Math.min(w, h) * 0.55,
        depth: rz,
      }
    }

    const drawFixedStars = (cam: {
      cy: number
      sy: number
      cp: number
      sp: number
    }) => {
      if (!starsEnabled || !starsCtx || !starsCanvas) return

      starsCtx.clearRect(0, 0, w, h)

      starsCtx.save()
      starsCtx.globalCompositeOperation = 'source-over'
      starsCtx.imageSmoothingEnabled = true

      for (let i = 0; i < stars.length; i++) {
        const st = stars[i]
        const p = projectStar(st.x, st.y, st.z, cam)
        const depth01 = Math.max(0, Math.min(1, (p.depth + 1) / 2))

        const a =
          Math.max(0, Math.min(1, starOpacity)) * st.a * (0.2 + 0.8 * depth01)

        const r = st.r * (0.9 + 1.2 * depth01)

        const bucket = Math.max(
          0,
          Math.min(
            STAR_BUCKETS - 1,
            Math.floor(((st.tint - 200) / 40) * (STAR_BUCKETS - 1)),
          ),
        )
        const spr = starSprites[bucket]

        starsCtx.globalAlpha = a
        starsCtx.drawImage(spr, p.sx - r, p.sy - r, r * 2, r * 2)
      }

      // cheap bloom pass
      starsCtx.globalCompositeOperation = 'lighter'
      starsCtx.globalAlpha = 0.18
      starsCtx.drawImage(starsCanvas, 0, 0)

      starsCtx.restore()
      starsCtx.globalAlpha = 1
    }

    // Fade attractor trails toward transparent
    const fadeAttractor = () => {
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      const t = Math.max(0, Math.min(1, trail))
      ctx.fillStyle = `rgba(0,0,0,${t})`
      ctx.fillRect(0, 0, w, h)
      ctx.restore()
    }

    resize()
    window.addEventListener('resize', resize)

    // Start transparent
    ctx.clearRect(0, 0, w, h)
    if (starsCtx) starsCtx.clearRect(0, 0, w, h)

    const animate = (nowMs: number) => {
      const cam = getCamera(nowMs)

      // Fixed stars (camera-aware): redraw every frame to match orbit
      if (starsEnabled) drawFixedStars(cam)

      // Attractor
      fadeAttractor()

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.imageSmoothingEnabled = true

      for (let i = 0; i < seeds.length; i++) {
        const p = seeds[i]
        p.px = p.x
        p.py = p.y
        p.pz = p.z

        for (let s = 0; s < stepsPerFrame; s++) rk4(p, dt)

        const a = deriv(p.x, p.y, p.z)
        const speed = Math.sqrt(a.dx * a.dx + a.dy * a.dy + a.dz * a.dz)
        const ns = Math.max(0, Math.min(1, speed / 60))
        const act = activation(ns)

        const p1 = projectAttractor(p.x, p.y, p.z, cam)
        const depth01 = Math.max(0, Math.min(1, (p1.depth + 1) / 2))

        const alpha = opacity * (0.35 + 0.65 * act) * (0.22 + 0.78 * depth01)
        const r = Math.max(0.9, (pointSize * (0.85 + 1.35 * depth01)) / 2)

        const bucket = Math.max(
          0,
          Math.min(ORB_BUCKETS - 1, Math.floor(act * (ORB_BUCKETS - 1))),
        )
        const spr = orbSprites[bucket]

        ctx.globalAlpha = alpha
        ctx.drawImage(spr, p1.sx - r, p1.sy - r, r * 2, r * 2)
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
    stars,
    starsEnabled,
    starOpacity,
    starDepth,
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
    orbitEnabled,
    orbitDelayMs,
    orbitSpeed,
    orbitPitch,
    orbitPitchWobble,
  ])

  return (
    <div
      className={
        'pointer-events-none fixed inset-0 -z-10 w-screen h-screen overflow-hidden ' +
        className
      }
    >
      {/* Backdrop layer */}
      <div
        className={'absolute inset-0 ' + backgroundClassName}
        style={{
          backgroundColor,
          opacity: Math.max(0, Math.min(1, backgroundOpacity)),
        }}
      />

      {/* Fixed starfield layer */}
      <canvas
        ref={starsCanvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ opacity: starsEnabled ? 1 : 0 }}
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
              'radial-gradient(1200px 800px at 50% 30%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%),' +
              'radial-gradient(1000px 700px at 20% 80%, rgba(99,102,241,0.06), rgba(0,0,0,0) 55%)',
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
            <h1 className="px-2 text-white py-1 text-lg font-semibold">
              Raffaele-Pacilio.io
            </h1>
          </div>
        </div>
      </nav>

      <LorenzAttractorBackground
        backgroundOpacity={1}
        backgroundColor="#020617"
        backgroundClassName="bg-gradient-to-b from-slate-950 via-blue-950/60 to-slate-950"
        starsEnabled
        particleCount={4000}
        renderScale={0.82}
        dprMax={1.25}
        velvetEnabled
        grainOpacity={0.06}
        orbitEnabled
        orbitDelayMs={0}
        orbitSpeed={0.11}
      />
    </>
  )
}
