/**
 * The hand-drawn control room. It is the fallback for the homepage when the
 * real studio photograph cannot be loaded (offline first visit, blocked
 * request, missing file), so the page still has a room behind it.
 */
const LED_ROWS = [0, 1, 2, 3, 4, 5, 6, 7]
const FADERS = [0.62, 0.48, 0.72, 0.35, 0.55, 0.68, 0.42, 0.6, 0.5, 0.74, 0.38, 0.58]
const KNOBS = Array.from({ length: 16 }, (_, i) => i)

export default function HomeScene({
  parallax,
  lights,
}: {
  parallax: { x: number; y: number }
  lights: number
}) {
  return (
    <svg
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      className="room-svg"
      role="img"
      aria-label="Illustration of the ILS control room: desk, console, studio monitors and rack gear."
      style={{ transform: `translate3d(${parallax.x * -10}px, ${parallax.y * -6}px, 0) scale(1.03)` }}
    >
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#101319" />
          <stop offset="55%" stopColor="#0c0f14" />
          <stop offset="100%" stopColor="#070809" />
        </linearGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#14171c" />
          <stop offset="100%" stopColor="#050607" />
        </linearGradient>
        <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8fb6c9" stopOpacity="0.16" />
          <stop offset="40%" stopColor="#cfe6f0" stopOpacity="0.07" />
          <stop offset="100%" stopColor="#7f9db0" stopOpacity="0.14" />
        </linearGradient>
        <linearGradient id="warm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0c27a" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#f0c27a" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#23262c" />
          <stop offset="45%" stopColor="#15171b" />
          <stop offset="100%" stopColor="#0b0c0e" />
        </linearGradient>
        <linearGradient id="screenGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0f2b30" />
          <stop offset="100%" stopColor="#08181c" />
        </linearGradient>
        <radialGradient id="lampGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffdca8" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ffdca8" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="cyanGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#5eead4" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#5eead4" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="vignette" cx="50%" cy="45%" r="70%">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.85" />
        </radialGradient>
      </defs>

      {/* room shell */}
      <rect width="1600" height="900" fill="url(#wall)" />
      <rect y="560" width="1600" height="340" fill="url(#floor)" />
      <path d="M0 560 L1600 560" stroke="#2a2f37" strokeWidth="2" />
      {/* acoustic panels */}
      {[0, 1, 2, 3].map((i) => (
        <g key={i} opacity={0.85}>
          <rect x={90 + i * 92} y={96} width={74} height={188} rx="4" fill="#15181d" stroke="#23272e" />
          {Array.from({ length: 9 }).map((_, r) => (
            <line key={r} x1={94 + i * 92} y1={108 + r * 20} x2={160 + i * 92} y2={108 + r * 20} stroke="#1d2127" strokeWidth="2" />
          ))}
        </g>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <g key={`r${i}`} opacity={0.8}>
          <rect x={1130 + i * 92} y={96} width={74} height={188} rx="4" fill="#15181d" stroke="#23272e" />
          {Array.from({ length: 9 }).map((_, r) => (
            <line key={r} x1={1134 + i * 92} y1={108 + r * 20} x2={1200 + i * 92} y2={108 + r * 20} stroke="#1d2127" strokeWidth="2" />
          ))}
        </g>
      ))}

      {/* live room window */}
      <g>
        <rect x="430" y="70" width="740" height="330" rx="10" fill="#0a0d10" stroke="#2b3138" strokeWidth="8" />
        <rect x="446" y="86" width="708" height="298" rx="6" fill="url(#glass)" />
        <rect x="446" y="86" width="708" height="298" rx="6" fill="#0d1418" opacity="0.6" />
        {/* live room contents */}
        <rect x="470" y="250" width="660" height="134" fill="#0b0f12" />
        <rect x="470" y="250" width="660" height="4" fill="#2c343c" opacity="0.7" />
        {/* vocal booth */}
        <g>
          <rect x="880" y="140" width="240" height="240" rx="4" fill="#101519" stroke="#2b333b" strokeWidth="3" />
          <rect x="896" y="156" width="208" height="208" fill="#0b1013" />
          {Array.from({ length: 8 }).map((_, i) => (
            <rect key={i} x={902 + (i % 4) * 50} y={162 + Math.floor(i / 4) * 96} width="44" height="90" fill="#141a1f" stroke="#1e252b" />
          ))}
          <rect x="988" y="300" width="30" height="46" rx="4" fill="#20262d" />
          <ellipse cx="1003" cy="296" rx="18" ry="8" fill="#2b3239" />
          <line x1="1003" y1="296" x2="1003" y2="270" stroke="#3a424b" strokeWidth="3" />
          <circle cx="1003" cy="264" r="7" fill="#454e58" />
          <rect x="880" y="140" width="240" height="240" rx="4" fill="url(#warm)" opacity="0.5" />
        </g>
        {/* piano silhouette */}
        <path d="M520 372 L700 372 L720 322 L560 322 Z" fill="#0f1317" stroke="#242b32" />
        <rect x="556" y="336" width="120" height="16" fill="#1a1f25" />
        {/* ceiling lamp */}
        <circle cx="760" cy="128" r="52" fill="url(#lampGlow)" />
        <rect x="748" y="96" width="24" height="10" rx="3" fill="#262c33" />
        {/* glass reflections */}
        <g opacity="0.16">
          <path d="M470 90 L620 90 L500 380 L470 380 Z" fill="#cfe9f5" />
          <path d="M700 90 L740 90 L620 380 L580 380 Z" fill="#cfe9f5" />
        </g>
        <rect x="446" y="86" width="708" height="298" rx="6" fill="none" stroke="#3a444d" strokeWidth="2" />
      </g>

      {/* studio monitors */}
      {[{ x: 232 }, { x: 1248 }].map((m, i) => (
        <g key={i} transform={`translate(${m.x}, 286) scale(0.82)`}>
          <rect x="0" y="0" width="170" height="230" rx="8" fill="#15181c" stroke="#2a2f36" strokeWidth="3" />
          <rect x="16" y="16" width="138" height="94" rx="4" fill="#0b0d10" stroke="#22272d" />
          <circle cx="85" cy="118" r="26" fill="#0d1013" stroke="#242a30" />
          <circle cx="85" cy="170" r="17" fill="#0d1013" stroke="#242a30" />
          <circle cx="85" cy="118" r="9" fill="#191d22" />
          <rect x="-24" y="230" width="218" height="12" rx="4" fill="#1a1e23" />
          <rect x="56" y="242" width="58" height="120" fill="#14181c" />
          <rect x="30" y="356" width="110" height="10" rx="4" fill="#1c2126" />
          <circle cx="152" cy="26" r="4" fill="#5eead4" opacity={lights % 5 === 0 ? 0.9 : 0.35} />
        </g>
      ))}

      {/* rack gear */}
      <g transform="translate(1046, 398) scale(0.72)">
        <rect x="0" y="0" width="330" height="300" rx="8" fill="#101318" stroke="#282e36" strokeWidth="3" />
        {LED_ROWS.map((r) => (
          <g key={r}>
            <rect x="14" y={16 + r * 34} width="302" height="26" rx="3" fill="#15191e" stroke="#20262d" />
            {Array.from({ length: 14 }).map((_, c) => {
              const on = (lights + r * 3 + c * 5) % 11 < 4
              return (
                <circle
                  key={c}
                  cx={30 + c * 12}
                  cy={29 + r * 34}
                  r="3"
                  fill={on ? (c % 4 === 0 ? '#5eead4' : '#e8c67a') : '#242a31'}
                  opacity={on ? 0.95 : 0.7}
                />
              )
            })}
            <rect x="206" y={24 + r * 34} width="100" height="10" rx="2" fill="#0c0f12" />
            <rect x="206" y={24 + r * 34} width={(r * 13 + lights) % 100} height="10" rx="2" fill="#5eead4" opacity="0.45" />
          </g>
        ))}
        <rect x="0" y="0" width="330" height="300" rx="8" fill="url(#cyanGlow)" opacity="0.18" />
      </g>

      {/* console desk */}
      <g>
        <path d="M180 900 L1420 900 L1330 640 L270 640 Z" fill="url(#desk)" stroke="#2b3138" strokeWidth="2" />
        <path d="M270 640 L1330 640 L1300 610 L300 610 Z" fill="#1b1f24" stroke="#2b3138" />
        {/* desk screen */}
        <g transform="translate(660, 500)">
          <rect x="0" y="0" width="290" height="120" rx="6" fill="url(#screenGrad)" stroke="#33434a" strokeWidth="3" />
          <rect x="12" y="12" width="266" height="96" rx="3" fill="#081417" />
          {Array.from({ length: 26 }).map((_, i) => (
            <rect
              key={i}
              x={18 + i * 10}
              y={96 - ((i * 37 + lights * 3) % 60)}
              width="6"
              height={((i * 37 + lights * 3) % 60) + 8}
              fill="#5eead4"
              opacity={0.5}
            />
          ))}
          <rect x="12" y="12" width="266" height="3" fill="#e8c67a" opacity="0.5" />
        </g>
        {/* faders and knobs */}
        {FADERS.map((h, i) => (
          <g key={i}>
            <rect x={310 + i * 78} y={668} width="46" height="120" rx="4" fill="#0e1114" stroke="#22282f" />
            <rect x={330 + i * 78} y={676} width="6" height="104" rx="3" fill="#1b2026" />
            <rect
              x={320 + i * 78}
              y={676 + (1 - h) * 88 + Math.sin((lights + i * 3) / 4) * 7}
              width="26"
              height="14"
              rx="3"
              fill={i % 3 === 0 ? '#d7a951' : '#3c444d'}
              stroke="#0a0c0f"
            />
          </g>
        ))}
        {KNOBS.map((k) => {
          const x = 300 + (k % 8) * 112 + 24
          const y = 812 + Math.floor(k / 8) * 40
          return (
            <g key={k}>
              <circle cx={x} cy={y} r="12" fill="#15191e" stroke="#2c333b" />
              <line
                x1={x}
                y1={y}
                x2={x + Math.cos(((k * 47) % 360) * (Math.PI / 180)) * 8}
                y2={y + Math.sin(((k * 47) % 360) * (Math.PI / 180)) * 8}
                stroke="#8a949f"
                strokeWidth="2"
              />
            </g>
          )
        })}
        {/* desk glow strip */}
        <path d="M300 610 L1300 610" stroke="#e8c67a" strokeWidth="2" opacity="0.4" />
        <path d="M270 640 L1330 640" stroke="#5eead4" strokeWidth="1" opacity="0.25" />
      </g>

      <rect width="1600" height="900" fill="url(#vignette)" />
    </svg>
  )
}
