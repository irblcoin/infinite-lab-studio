// ---------------------------------------------------------------------------
// SF2 (SoundFont 2) reader
//
// Reads the RIFF structure directly and turns presets into sample zones.
// Only the generators needed for faithful playback are interpreted: key and
// velocity ranges, root key, tuning, pan, attenuation, loop mode and sample
// offsets. Sample data lives in the 16-bit `smpl` chunk.
// ---------------------------------------------------------------------------

export interface Sf2Zone {
  sampleIndex: number
  keyLo: number
  keyHi: number
  velLo: number
  velHi: number
  root: number
  tune: number
  gain: number
  pan: number
  start: number
  end: number
  loopStart: number
  loopEnd: number
  loop: boolean
}

export interface Sf2Preset {
  name: string
  bank: number
  program: number
  zones: Sf2Zone[]
}

export interface Sf2Sample {
  name: string
  sampleRate: number
  data: Float32Array
}

export interface Sf2Result {
  presets: Sf2Preset[]
  samples: Sf2Sample[]
}

function fourCC(v: DataView, off: number): string {
  return String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3))
}

function readName(v: DataView, off: number, len = 20): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = v.getUint8(off + i)
    if (!c) break
    s += String.fromCharCode(c)
  }
  return s.trim()
}

function* chunks(v: DataView, start: number, end: number): Generator<{ id: string; start: number; size: number }> {
  let p = start
  while (p + 8 <= end) {
    const id = fourCC(v, p)
    const size = v.getUint32(p + 4, true)
    if (p + 8 + size > end) break
    yield { id, start: p + 8, size }
    p += 8 + size + (size % 2)
  }
}

export function parseSf2(buffer: ArrayBuffer): Sf2Result {
  const v = new DataView(buffer)
  if (v.byteLength < 12 || fourCC(v, 0) !== 'RIFF' || fourCC(v, 8) !== 'sfbk') {
    throw new Error('Not a SoundFont 2 file')
  }
  const total = v.byteLength
  let pdtaStart = -1
  let pdtaEnd = -1
  let smplStart = -1
  let smplSize = 0

  for (const top of chunks(v, 12, total)) {
    if (top.id !== 'LIST') continue
    const listType = fourCC(v, top.start)
    if (listType === 'pdta') {
      pdtaStart = top.start + 4
      pdtaEnd = top.start + top.size
      continue
    }
    if (listType === 'sdta') {
      for (const c of chunks(v, top.start + 4, top.start + top.size)) {
        if (c.id === 'smpl') {
          smplStart = c.start
          smplSize = c.size
        }
      }
    }
  }
  if (pdtaStart < 0 || smplStart < 0) throw new Error('SoundFont is missing its sample or preset data')

  interface Bag {
    genIndex: number
  }
  interface Gen {
    oper: number
    amount: number
  }
  const bags: Bag[] = []
  const gens: Gen[] = []
  const headers: { name: string; preset: number; bank: number; bagIndex: number }[] = []
  const instHeaders: { name: string; bagIndex: number }[] = []
  const sampleHeaders: {
    name: string
    start: number
    end: number
    loopStart: number
    loopEnd: number
    sampleRate: number
    originalPitch: number
    pitchCorrection: number
  }[] = []
  const instBags: Bag[] = []
  const instGens: Gen[] = []

  const walk = (start: number, end: number, cb: (id: string, s: number, size: number) => void): void => {
    for (const c of chunks(v, start, end)) cb(c.id, c.start, c.size)
  }

  walk(pdtaStart, pdtaEnd, (id, s, size) => {
    if (id === 'phdr') {
      for (let p = s; p + 38 <= s + size; p += 38) {
        headers.push({
          name: readName(v, p),
          preset: v.getUint16(p + 20, true),
          bank: v.getUint16(p + 22, true),
          bagIndex: v.getUint16(p + 24, true),
        })
      }
    } else if (id === 'pbag') {
      for (let p = s; p + 4 <= s + size; p += 4) bags.push({ genIndex: v.getUint16(p, true) })
    } else if (id === 'pgen' || id === 'igen') {
      const target = id === 'pgen' ? gens : instGens
      for (let p = s; p + 4 <= s + size; p += 4) {
        target.push({ oper: v.getUint16(p, true), amount: v.getInt16(p + 2, true) })
      }
    } else if (id === 'inst') {
      for (let p = s; p + 22 <= s + size; p += 22) {
        instHeaders.push({ name: readName(v, p), bagIndex: v.getUint16(p + 20, true) })
      }
    } else if (id === 'ibag') {
      for (let p = s; p + 4 <= s + size; p += 4) instBags.push({ genIndex: v.getUint16(p, true) })
    } else if (id === 'shdr') {
      for (let p = s; p + 46 <= s + size; p += 46) {
        sampleHeaders.push({
          name: readName(v, p),
          start: v.getUint32(p + 20, true),
          end: v.getUint32(p + 24, true),
          loopStart: v.getUint32(p + 28, true),
          loopEnd: v.getUint32(p + 32, true),
          sampleRate: v.getUint32(p + 36, true),
          originalPitch: v.getUint8(p + 40),
          pitchCorrection: v.getInt8(p + 41),
        })
      }
    }
  })

  const genDefaults = (): { keyLo: number; keyHi: number; velLo: number; velHi: number; root: number; tune: number; gain: number; pan: number; sampleIndex: number; loop: boolean; start: number; end: number } => ({
    keyLo: 0,
    keyHi: 127,
    velLo: 0,
    velHi: 127,
    root: -1,
    tune: 0,
    gain: 1,
    pan: 0,
    sampleIndex: -1,
    loop: false,
    start: 0,
    end: 0,
  })

  type GenState = ReturnType<typeof genDefaults>

  const applyGen = (g: GenState, gen: Gen): void => {
    switch (gen.oper) {
      case 43: // keyRange
        g.keyLo = gen.amount & 0xff
        g.keyHi = (gen.amount >> 8) & 0xff
        break
      case 44: // velRange
        g.velLo = gen.amount & 0xff
        g.velHi = (gen.amount >> 8) & 0xff
        break
      case 58:
        g.root = gen.amount
        break
      case 51:
        g.tune += gen.amount * 100
        break
      case 52:
        g.tune += gen.amount
        break
      case 17:
        g.pan = Math.max(-1, Math.min(1, gen.amount / 500))
        break
      case 48:
        g.gain *= Math.pow(10, -gen.amount / 200)
        break
      case 53:
        g.sampleIndex = gen.amount
        break
      case 54:
        g.loop = (gen.amount & 3) === 1 || (gen.amount & 3) === 3
        break
      case 0:
        g.start += gen.amount
        break
      case 1:
        g.end += gen.amount
        break
      case 2:
        g.start += gen.amount * 32768
        break
      case 3:
        g.end += gen.amount * 32768
        break
      case 4:
      default:
        break
    }
  }

  const presets: Sf2Preset[] = []
  for (let i = 0; i < headers.length - 1; i++) {
    const h = headers[i]
    const nextBag = headers[i + 1].bagIndex
    const zones: Sf2Zone[] = []
    for (let b = h.bagIndex; b < nextBag && b < bags.length; b++) {
      const startGen = bags[b].genIndex
      const endGen = b + 1 < bags.length ? bags[b + 1].genIndex : gens.length
      const presetState = genDefaults()
      let instrumentIndex = -1
      for (let k = startGen; k < endGen; k++) {
        const gen = gens[k]
        if (!gen) continue
        if (gen.oper === 41) instrumentIndex = gen.amount
        else applyGen(presetState, gen)
      }
      if (instrumentIndex < 0 || instrumentIndex >= instHeaders.length) continue
      const inst = instHeaders[instrumentIndex]
      const nextInstBag = instHeaders[instrumentIndex + 1]?.bagIndex ?? instBags.length
      for (let ib = inst.bagIndex; ib < nextInstBag && ib < instBags.length; ib++) {
        const sGen = instBags[ib].genIndex
        const eGen = ib + 1 < instBags.length ? instBags[ib + 1].genIndex : instGens.length
        const st = { ...presetState }
        for (let k = sGen; k < eGen; k++) {
          const gen = instGens[k]
          if (!gen) continue
          applyGen(st, gen)
        }
        if (st.sampleIndex < 0 || st.sampleIndex >= sampleHeaders.length) continue
        const sh = sampleHeaders[st.sampleIndex]
        const root = st.root >= 0 ? st.root : Math.min(127, Math.max(0, sh.originalPitch - 0)) + (sh.pitchCorrection ? 0 : 0)
        zones.push({
          sampleIndex: st.sampleIndex,
          keyLo: st.keyLo,
          keyHi: st.keyHi,
          velLo: st.velLo,
          velHi: st.velHi,
          root,
          tune: st.tune + sh.pitchCorrection * 100,
          gain: st.gain,
          pan: st.pan,
          start: Math.max(0, st.start),
          end: st.end,
          loopStart: sh.loopStart,
          loopEnd: sh.loopEnd,
          loop: st.loop,
        })
        void sh
      }
    }
    if (zones.length) {
      presets.push({ name: h.name || `Preset ${i}`, bank: h.bank, program: h.preset, zones })
    }
  }

  // Only decode samples that are actually used.
  const used = new Set<number>()
  for (const p of presets) for (const z of p.zones) used.add(z.sampleIndex)
  const samples: Sf2Sample[] = sampleHeaders.map((sh, idx) => {
    const start = sh.start
    const end = Math.min(sh.end, smplSize / 2)
    const len = Math.max(0, end - start)
    const data = new Float32Array(used.has(idx) ? len : 0)
    for (let i = 0; i < len; i++) data[i] = v.getInt16(smplStart + (start + i) * 2, true) / 32768
    return { name: sh.name || `sample_${idx}`, sampleRate: sh.sampleRate || 44100, data }
  })

  return { presets, samples }
}

/** Minimal 16-bit PCM WAV writer for extracted SF2 samples. */
export function encodeWav16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const frames = channels[0]?.length ?? 0
  const ch = Math.max(1, channels.length)
  const buffer = new ArrayBuffer(44 + frames * ch * 2)
  const v = new DataView(buffer)
  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + frames * ch * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, ch, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * ch * 2, true)
  v.setUint16(32, ch * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, frames * ch * 2, true)
  let p = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0))
      v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      p += 2
    }
  }
  return buffer
}
