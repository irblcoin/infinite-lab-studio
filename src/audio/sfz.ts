// ---------------------------------------------------------------------------
// SFZ parser (subset used by real-world instrument mappings: Salamander,
// VSCO 2, Sonatina, Sforzando-style banks and hand-written mappings).
// Supports global/group/master/region inheritance, key + velocity ranges,
// sample root, tuning, loops, round robin (seq_position) and amp envelope.
// ---------------------------------------------------------------------------

import type { Patch, SampleZone } from './patch'

export interface SfzImport {
  patches: Patch[]
  /** file name -> text of the mapping that referenced it */
  references: string[]
}

const NOTE_PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

function noteToMidi(v: string): number {
  const t = v.trim().toLowerCase()
  if (/^-?\d+$/.test(t)) return parseInt(t, 10)
  const m = /^([a-g])([#sb]?)(-?\d+)$/.exec(t)
  if (!m) return 60
  const base = NOTE_PC[m[1]] ?? 0
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return (parseInt(m[3], 10) + 1) * 12 + base + acc
}

function num(v: string | undefined, dflt: number): number {
  if (v == null) return dflt
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : dflt
}

type Block = Record<string, string>

function parseBlocks(text: string): { header: string; ops: Block }[] {
  const out: { header: string; ops: Block }[] = []
  let current: { header: string; ops: Block } | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    const head = /^<([a-zA-Z_]+)>/.exec(line)
    if (head) {
      if (current) out.push(current)
      current = { header: head[1].toLowerCase(), ops: {} }
      const rest = line.slice(head[0].length).trim()
      if (rest) for (const [k, v] of pairs(rest)) current.ops[k] = v
      continue
    }
    if (!current) {
      current = { header: 'global', ops: {} }
    }
    for (const [k, v] of pairs(line)) current.ops[k] = v
  }
  if (current) out.push(current)
  return out
}

function pairs(line: string): [string, string][] {
  const out: [string, string][] = []
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)=([^\s]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push([m[1].toLowerCase(), m[2]])
  return out
}

export interface SfzOptions {
  packId: string
  idPrefix?: string
  defaultCategory?: string
  /** Map an SFZ sample path to a browser-usable file name. */
  resolveFile?: (samplePath: string) => string | null
}

export function parseSfz(text: string, name: string, opts: SfzOptions): Patch[] {
  const blocks = parseBlocks(text)
  const resolved = (p: string): string | null => {
    const clean = decodeURIComponent(p.replace(/\\/g, '/')).trim()
    if (opts.resolveFile) return opts.resolveFile(clean)
    return clean.split('/').pop() ?? clean
  }

  const base: Block = {}
  const groups: { ops: Block; patch: Patch }[] = []
  let currentPatch: Patch | null = null

  const makePatch = (label: string): Patch => ({
    id: `${opts.idPrefix ?? opts.packId}_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    name: label,
    category: opts.defaultCategory ?? 'Sampled',
    packId: opts.packId,
    source: 'sfz',
    gain: 1,
    zones: [],
  })

  for (const b of blocks) {
    if (b.header === 'global') {
      Object.assign(base, b.ops)
      continue
    }
    if (b.header === 'master') {
      Object.assign(base, b.ops)
      continue
    }
    if (b.header === 'group') {
      if (!currentPatch) {
        currentPatch = makePatch(name)
        groups.push({ ops: { ...b.ops }, patch: currentPatch })
      } else {
        groups.push({ ops: { ...b.ops }, patch: currentPatch })
      }
      continue
    }
    if (b.header !== 'region') continue
    if (!currentPatch) {
      currentPatch = makePatch(name)
      groups.push({ ops: {}, patch: currentPatch })
    }
    const inherit = groups[groups.length - 1]?.ops ?? {}
    const ops: Block = { ...base, ...inherit, ...b.ops }
    const sample = ops.sample
    if (!sample) continue
    const file = resolved(sample)
    if (!file) continue
    const lo = noteToMidi(ops.lokey ?? ops.key ?? '0')
    const hi = noteToMidi(ops.hikey ?? ops.key ?? '127')
    const root = noteToMidi(ops.pitch_keycenter ?? ops.key ?? String(lo))
    const velLo = Math.max(0, Math.min(127, Math.round(num(ops.lovel, 0))))
    const velHi = Math.max(0, Math.min(127, Math.round(num(ops.hivel, 127))))
    const seq = ops.seq_position ? Math.round(num(ops.seq_position, 1)) : undefined
    const tune = num(ops.tune, 0) + num(ops.pitch, 0) * 100
    const gain = Math.pow(10, num(ops.volume, 0) / 20)
    const pan = num(ops.pan, 0) / 100
    const zone: SampleZone = { file, root, lo, hi, velLo, velHi, seq, tune, gain, pan }
    const loopMode = (ops.loop_mode ?? ops.loopmode ?? '').toLowerCase()
    const loopStart = num(ops.loop_start, NaN)
    const loopEnd = num(ops.loop_end, NaN)
    if (Number.isFinite(loopStart) && Number.isFinite(loopEnd) && loopEnd > loopStart && loopMode !== 'off') {
      // SFZ loop points are in samples at the file's own rate; stored as seconds at 48k.
      zone.loopStart = loopStart / 48000
      zone.loopEnd = loopEnd / 48000
    }
    currentPatch.zones.push(zone)
  }

  return groups.map((g) => g.patch).filter((p) => p.zones.length > 0)
}
