import type { Clip, DeviceType, Params, Project, Track } from '../state/types'
import { clamp } from '../state/types'
import { DEVICE_DEFS, defaultParams } from '../data/deviceDefs'
import { createEffect, type FXNode } from './effects'
import { playInstrument } from './instruments'
import { getBuffer } from './assets'
import { ensureLibraryBuffer } from '../data/library'
import { gainNode, impulseResponse, noiseBuffer, percEnv, reversedBuffer, safeFreq } from './dsp'
import { beatAfter, bpmAt } from './tempo'
import { warpForClip, warpRatio } from './warp'
import { lufsFromAnalyser } from './analysis'
import { grooveAmount } from '../data/presets'
import type { MasterChain } from '../state/types'

export type ReturnPresetId = 'plate' | 'hall' | 'slap' | 'tape'

const LOOKAHEAD = 0.16
const TICK_MS = 25

export const isInstrument = (t: DeviceType): boolean => DEVICE_DEFS[t]?.category === 'instrument'

interface TrackGraph {
  id: string
  input: GainNode
  playBus: GainNode | null
  fxChain: FXNode[]
  fxSig: string
  fader: GainNode
  /** Sidechain ducking stage, sits between the fader and the panner. */
  duck: GainNode
  pan: StereoPannerNode
  analyser: AnalyserNode
  sendA: GainNode
  sendB: GainNode
  route: string
}

interface MasterGraph {
  input: GainNode
  glue: DynamicsCompressorNode
  eqLow: BiquadFilterNode
  eqMid: BiquadFilterNode
  eqHigh: BiquadFilterNode
  limiter: DynamicsCompressorNode
  gain: GainNode
  analyser: AnalyserNode
  splitter: ChannelSplitterNode
  analyserL: AnalyserNode
  analyserR: AnalyserNode
  reverbIn: GainNode
  convolver: ConvolverNode
  reverbOut: GainNode
  delayIn: GainNode
  delayL: DelayNode
  delayR: DelayNode
  delayFb: GainNode
  delayOut: GainNode
}

export interface SchedEvent {
  beat: number
  dur: number
  trackId: string
  kind: 'note' | 'audio'
  pitch?: number
  vel?: number
  clip?: Clip
}

export interface MicStatus {
  ready: boolean
  error?: string
  level: number
}

export function audibleTracks(project: Project): Set<string> {
  const soloed = new Set(project.tracks.filter((t) => t.solo && !t.mute).map((t) => t.id))
  const anySolo = soloed.size > 0
  const out = new Set<string>()
  for (const t of project.tracks) {
    if (t.mute) continue
    if (anySolo) {
      if (t.solo) {
        out.add(t.id)
        continue
      }
      if (t.output !== 'master' && soloed.has(t.output)) {
        out.add(t.id)
        continue
      }
      continue
    }
    out.add(t.id)
  }
  // mute children of muted groups
  for (const t of project.tracks) {
    if (t.output !== 'master' && !out.has(t.output)) out.delete(t.id)
  }
  return out
}

export function buildEvents(project: Project): SchedEvent[] {
  const out: SchedEvent[] = []
  const globalGroove = project.groove ? grooveAmount(project.groove) : { swing: 0, velocity: 0 }
  for (const track of project.tracks) {
    if (track.kind === 'group') continue
    if (track.frozenAssetId) {
      out.push({ beat: 0, dur: project.length, trackId: track.id, kind: 'audio' })
      continue
    }
    for (const clip of track.clips) {
      const cycle = Math.max(0.0625, clip.contentLen || clip.len)
      if (clip.kind === 'midi') {
        const passes = clip.loop ? Math.ceil(clip.len / cycle - 1e-6) : 1
        for (let p = 0; p < Math.max(1, passes); p++) {
          const base = p * cycle
          if (base >= clip.len - 1e-6) break
          const g = clip.groove ? grooveAmount(clip.groove) : globalGroove
          for (const note of clip.notes) {
            let rel = base + note.start
            if (rel >= clip.len - 1e-6) continue
            let vel = note.vel
            if (g.swing > 0 || g.velocity > 0) {
              const step = Math.round(rel * 4)
              const offbeat = Math.abs(rel * 4 - step) < 0.05 && step % 2 === 1
              if (offbeat) rel += g.swing * 0.25
              if (step % 4 === 2) vel = Math.max(0.05, vel * (1 + g.velocity * 0.35))
              else if (step % 2 === 1) vel = Math.max(0.05, vel * (1 - g.velocity * 0.5))
            }
            const dur = Math.min(note.len, clip.len - rel)
            if (dur <= 0.004) continue
            out.push({
              beat: clip.start + rel,
              dur,
              trackId: track.id,
              kind: 'note',
              pitch: note.pitch,
              vel,
              clip,
            })
          }
        }
      } else if (clip.comp && clip.comp.length) {
        for (const region of clip.comp) {
          const start = Math.max(0, Math.min(clip.len, region.start))
          const end = Math.max(start, Math.min(clip.len, region.end))
          if (end - start <= 0.004) continue
          out.push({
            beat: clip.start + start,
            dur: end - start,
            trackId: track.id,
            kind: 'audio',
            clip: { ...clip, activeTake: region.take },
          })
        }
      } else {
        const passes = clip.loop ? Math.ceil(clip.len / cycle - 1e-6) : 1
        for (let p = 0; p < Math.max(1, passes); p++) {
          const rel = p * cycle
          if (rel >= clip.len - 1e-6) break
          out.push({
            beat: clip.start + rel,
            dur: Math.min(cycle, clip.len - rel),
            trackId: track.id,
            kind: 'audio',
            clip,
          })
        }
      }
    }
  }
  // Drum Rack choke groups: a pad in a group cuts the previous pad short.
  for (const track of project.tracks) {
    const inst = track.devices.find((d) => d.type === 'drums')
    if (!inst?.padMap) continue
    const groups = new Map<number, SchedEvent[]>()
    for (const ev of out) {
      if (ev.trackId !== track.id || ev.kind !== 'note' || ev.pitch == null) continue
      const group = inst.padMap[String(ev.pitch)]?.choke ?? 0
      if (group <= 0) continue
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group)!.push(ev)
    }
    for (const evs of groups.values()) {
      evs.sort((a, b) => a.beat - b.beat)
      for (let i = 1; i < evs.length; i++) {
        const prev = evs[i - 1]
        const next = evs[i]
        if (prev.beat + prev.dur > next.beat - 1e-6) {
          prev.dur = Math.max(0.02, next.beat - prev.beat)
        }
      }
    }
  }
  return out.sort((a, b) => a.beat - b.beat)
}

class AudioEngine {
  ctx: AudioContext | null = null
  private master: MasterGraph | null = null
  private graphs = new Map<string, TrackGraph>()
  private meterBufs = new Map<string, Float32Array<ArrayBuffer>>()
  private project: Project | null = null
  private events: SchedEvent[] = []
  private eventsProject: Project | null = null
  private eventIdx = 0
  private bpm = 120
  private loop = { enabled: false, start: 0, end: 16 }
  private playing = false
  private countIn = 0
  private anchorBeat = 0
  private anchorTime = 0
  private schedBeat = 0
  private schedTime = 0
  private pausedBeat = 0
  private timer = 0
  private metronome = false
  private load = 0
  private liveLaunches: { clipId: string; trackId: string; nextTime: number; cycleSec: number; clip: Clip }[] = []
  launchedIds = new Set<string>()

  micStream: MediaStream | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private micGain: GainNode | null = null
  private micAnalyser: AnalyserNode | null = null
  private recorder: MediaRecorder | null = null
  private recChunks: Blob[] = []
  private monitoring = false

  // -------------------------------------------------------------------------
  // setup
  // -------------------------------------------------------------------------
  get active(): boolean {
    return !!this.ctx && this.ctx.state === 'running'
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000
  }

  /** Master input, used by external hosts such as WAM plugins. */
  get masterInput(): AudioNode {
    return this.master?.input ?? this.ctx!.destination
  }

  async start(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctor({ latencyHint: 'interactive' })
      this.buildMaster()
      // Creative worklets (looper) run on the audio thread. A browser without
      // AudioWorklet keeps the node-graph fallbacks in effects.ts.
      if (this.ctx.audioWorklet) {
        this.ctx.audioWorklet.addModule('/worklets/looper.js').catch(() => undefined)
      }
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume()
      } catch {
        /* ignored */
      }
    }
    return this.ctx
  }

  private buildMaster(): void {
    const ctx = this.ctx!
    const input = gainNode(ctx, 0.92)
    // master chain: tone EQ → glue compressor → limiter
    const eqLow = ctx.createBiquadFilter()
    eqLow.type = 'lowshelf'
    eqLow.frequency.value = 180
    eqLow.gain.value = 0
    const eqMid = ctx.createBiquadFilter()
    eqMid.type = 'peaking'
    eqMid.frequency.value = 900
    eqMid.Q.value = 0.9
    eqMid.gain.value = 0
    const eqHigh = ctx.createBiquadFilter()
    eqHigh.type = 'highshelf'
    eqHigh.frequency.value = 6000
    eqHigh.gain.value = 0
    const glue = ctx.createDynamicsCompressor()
    glue.threshold.value = -12
    glue.ratio.value = 2
    glue.knee.value = 6
    glue.attack.value = 0.02
    glue.release.value = 0.24
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = 0
    limiter.ratio.value = 1
    limiter.knee.value = 0
    limiter.attack.value = 0.001
    limiter.release.value = 0.1
    const gain = gainNode(ctx, 0.85)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.75
    const splitter = ctx.createChannelSplitter(2)
    const analyserL = ctx.createAnalyser()
    const analyserR = ctx.createAnalyser()
    analyserL.fftSize = 2048
    analyserR.fftSize = 2048
    // Mid/side width matrix: outL = M + width·S, outR = M − width·S.
    const mSplit = ctx.createChannelSplitter(2)
    const midL = gainNode(ctx, 0.5)
    const midR = gainNode(ctx, 0.5)
    const sideL = gainNode(ctx, 0.5)
    const sideR = gainNode(ctx, -0.5)
    const widthInL = gainNode(ctx, 1)
    const widthInR = gainNode(ctx, 1)
    const msMerge = ctx.createChannelMerger(2)
    input.connect(eqLow).connect(eqMid).connect(eqHigh).connect(glue).connect(limiter)
    limiter.connect(mSplit)
    mSplit.connect(midL, 0)
    mSplit.connect(midR, 1)
    mSplit.connect(sideL, 0)
    mSplit.connect(sideR, 1)
    midL.connect(msMerge, 0, 0)
    sideL.connect(widthInL).connect(msMerge, 0, 0)
    midR.connect(msMerge, 0, 1)
    sideR.connect(widthInR).connect(msMerge, 0, 1)
    msMerge.connect(gain)
    this.widthL = widthInL
    this.widthR = widthInR
    gain.connect(analyser).connect(ctx.destination)
    gain.connect(splitter)
    splitter.connect(analyserL, 0)
    splitter.connect(analyserR, 1)

    const reverbIn = gainNode(ctx, 1)
    const convolver = ctx.createConvolver()
    convolver.buffer = impulseResponse(ctx, 2.8, 0.45, 0.6)
    const reverbOut = gainNode(ctx, 0.9)
    reverbIn.connect(convolver).connect(reverbOut).connect(input)

    const delayIn = gainNode(ctx, 1)
    const delayL = ctx.createDelay(3)
    const delayR = ctx.createDelay(3)
    const delayFb = gainNode(ctx, 0.36)
    const delayOut = gainNode(ctx, 0.85)
    delayL.delayTime.value = 0.25
    delayR.delayTime.value = 0.5
    delayIn.connect(delayL)
    delayL.connect(delayR)
    delayR.connect(delayFb).connect(delayL)
    const merger = ctx.createChannelMerger(2)
    delayL.connect(merger, 0, 0)
    delayR.connect(merger, 0, 1)
    merger.connect(delayOut).connect(input)

    this.master = {
      input,
      glue,
      eqLow,
      eqMid,
      eqHigh,
      limiter,
      gain,
      analyser,
      splitter,
      analyserL,
      analyserR,
      reverbIn,
      convolver,
      reverbOut,
      delayIn,
      delayL,
      delayR,
      delayFb,
      delayOut,
    }
  }

  private ensureGraph(track: Track): TrackGraph {
    const existing = this.graphs.get(track.id)
    if (existing) return existing
    const ctx = this.ctx!
    const input = gainNode(ctx, 1)
    const fader = gainNode(ctx, track.volume)
    const duck = gainNode(ctx, 1)
    const pan = ctx.createStereoPanner()
    pan.pan.value = clamp(track.pan, -1, 1)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    const sendA = gainNode(ctx, 0)
    const sendB = gainNode(ctx, 0)
    fader.connect(duck).connect(pan)
    pan.connect(analyser)
    pan.connect(sendA).connect(this.master!.reverbIn)
    pan.connect(sendB).connect(this.master!.delayIn)
    const g: TrackGraph = {
      id: track.id,
      input,
      playBus: null,
      fxChain: [],
      // Sentinel: never equal to a real chain signature, so buildFxChain
      // always wires input → (effects) → fader on the first sync.
      fxSig: '\u0000unbuilt',
      fader,
      duck,
      pan,
      analyser,
      sendA,
      sendB,
      route: '',
    }
    this.graphs.set(track.id, g)
    return g
  }

  private buildFxChain(g: TrackGraph, track: Track): void {
    if (!this.ctx) return
    const effects = track.frozenAssetId
      ? []
      : track.devices.filter((d) => !d.bypass && DEVICE_DEFS[d.type].category === 'effect')
    const sig = effects.map((d) => `${d.id}:${d.type}`).join('|')
    if (sig === g.fxSig) {
      effects.forEach((d, i) => {
        const node = g.fxChain[i]
        if (!node) return
        for (const [k, v] of Object.entries(d.params)) node.set(k, v)
      })
      return
    }
    try {
      g.input.disconnect()
    } catch {
      /* noop */
    }
    for (const fx of g.fxChain) fx.dispose()
    g.fxChain = effects.map((d) => createEffect(this.ctx!, d.type, d.params))
    let node: AudioNode = g.input
    for (const fx of g.fxChain) {
      node.connect(fx.input)
      node = fx.output
    }
    node.connect(g.fader)
    g.fxSig = sig
  }

  private routeTrack(g: TrackGraph, track: Track): void {
    const dest = track.output !== 'master' ? this.graphs.get(track.output)?.input : null
    const target = track.output !== 'master' && dest ? dest : this.master!.input
    const sig = track.output !== 'master' && dest ? track.output : 'master'
    if (g.route === sig) return
    try {
      g.analyser.disconnect()
    } catch {
      /* noop */
    }
    g.analyser.connect(target)
    g.route = sig
  }

  /** Reconcile the live audio graph with the project document. */
  sync(project: Project): void {
    const prevBpm = this.bpm
    this.project = project
    this.bpm = project.bpm
    this.loop = project.loop
    if (!this.ctx || !this.master) return

    const m = this.master
    m.gain.gain.setTargetAtTime(clamp(project.master.volume, 0, 1.5), this.ctx.currentTime, 0.02)
    if (project.master.limiterOn) {
      m.limiter.threshold.setTargetAtTime(project.master.ceiling - 1.2, this.ctx.currentTime, 0.02)
      m.limiter.ratio.value = 20
      m.limiter.attack.value = 0.001
      m.limiter.release.value = 0.1
    } else {
      m.limiter.threshold.value = 0
      m.limiter.ratio.value = 1
    }
    const beatSec = 60 / project.bpm
    m.delayL.delayTime.setTargetAtTime(beatSec * 0.5, this.ctx.currentTime, 0.05)
    m.delayR.delayTime.setTargetAtTime(beatSec * 0.75, this.ctx.currentTime, 0.05)
    if (project.masterChain) this.setMasterChain(project.masterChain)

    const ids = new Set(project.tracks.map((t) => t.id))
    for (const [id, g] of this.graphs) {
      if (!ids.has(id)) {
        try {
          g.input.disconnect()
          g.fader.disconnect()
          g.pan.disconnect()
          g.analyser.disconnect()
          g.sendA.disconnect()
          g.sendB.disconnect()
          g.playBus?.disconnect()
        } catch {
          /* noop */
        }
        for (const fx of g.fxChain) fx.dispose()
        this.graphs.delete(id)
      }
    }

    for (const track of project.tracks) {
      const g = this.ensureGraph(track)
      this.buildFxChain(g, track)
      const hasVolAuto = track.automation.some((a) => a.target === 'volume' && a.points.length > 1)
      const hasPanAuto = track.automation.some((a) => a.target === 'pan' && a.points.length > 1)
      if (!hasVolAuto) g.fader.gain.setTargetAtTime(clamp(track.volume, 0, 1.6), this.ctx.currentTime, 0.015)
      if (!hasPanAuto) g.pan.pan.setTargetAtTime(clamp(track.pan, -1, 1), this.ctx.currentTime, 0.015)
      const hasA = track.automation.some((a) => a.target === 'sendA' && a.points.length > 1)
      const hasB = track.automation.some((a) => a.target === 'sendB' && a.points.length > 1)
      if (!hasA) g.sendA.gain.setTargetAtTime(clamp(track.sends[0], 0, 1), this.ctx.currentTime, 0.02)
      if (!hasB) g.sendB.gain.setTargetAtTime(clamp(track.sends[1], 0, 1), this.ctx.currentTime, 0.02)
      if (!track.sidechain?.enabled) g.duck.gain.setTargetAtTime(1, this.ctx.currentTime, 0.03)
      this.routeTrack(g, track)
    }

    if (prevBpm !== project.bpm && this.playing) {
      const at = this.getBeat()
      this.play(at, 0)
    }
  }

  // -------------------------------------------------------------------------
  // transport
  // -------------------------------------------------------------------------
  get isPlaying(): boolean {
    return this.playing
  }

  get isCountingIn(): boolean {
    if (!this.playing || !this.ctx) return false
    return this.getBeat() < this.anchorBeat + this.countIn
  }

  private createPlayBuses(): void {
    for (const g of this.graphs.values()) {
      g.playBus?.disconnect()
      const bus = gainNode(this.ctx!, 1)
      bus.connect(g.input)
      g.playBus = bus
    }
  }

  private silencePlayBuses(): void {
    for (const g of this.graphs.values()) {
      if (g.playBus) {
        try {
          g.playBus.gain.setValueAtTime(0, this.ctx!.currentTime)
          g.playBus.disconnect()
        } catch {
          /* noop */
        }
        g.playBus = null
      }
    }
  }

  play(fromBeat = this.pausedBeat, countInBeats = 0): boolean {
    if (!this.ctx) return false
    this.stopScheduler()
    this.createPlayBuses()
    const start = this.ctx.currentTime + 0.08
    this.anchorBeat = fromBeat - countInBeats
    this.anchorTime = start
    this.schedBeat = this.anchorBeat
    this.schedTime = start
    this.countIn = countInBeats
    this.eventIdx = 0
    this.playing = true
    if (this.project) {
      this.buildEvents(this.project)
    }
    this.timer = window.setInterval(this.tick, TICK_MS)
    this.tick()
    return true
  }

  private stopScheduler(): void {
    if (this.timer) window.clearInterval(this.timer)
    this.timer = 0
    this.playing = false
  }

  stop(): void {
    const beat = this.getBeat()
    this.pausedBeat = this.loop.enabled ? clamp(beat, this.loop.start, this.loop.end) : beat
    this.stopScheduler()
    this.silencePlayBuses()
    this.liveLaunches = []
    this.launchedIds.clear()
  }

  seek(beat: number): void {
    const b = Math.max(0, beat)
    this.pausedBeat = b
    if (this.playing) this.play(b, 0)
  }

  getBeat(): number {
    if (!this.ctx) return this.pausedBeat
    if (!this.playing) return this.pausedBeat
    const elapsed = this.ctx.currentTime - this.anchorTime
    const tempoProject = this.project
    let beat = tempoProject ? beatAfter(tempoProject, this.anchorBeat, elapsed) : this.anchorBeat + elapsed / (60 / this.bpm)
    if (this.loop.enabled && this.loop.end > this.loop.start && beat >= this.loop.end) {
      const len = this.loop.end - this.loop.start
      beat = this.loop.start + ((beat - this.loop.start) % len)
    }
    return beat
  }

  setMetronome(on: boolean): void {
    this.metronome = on
  }

  setMonitoring(on: boolean): void {
    this.monitoring = on
    this.rewireMic()
  }

  private rewireMic(): void {
    if (!this.micGain || !this.ctx || !this.master) return
    try {
      this.micGain.disconnect()
    } catch {
      /* noop */
    }
    if (!this.monitoring) return
    const armed = this.project?.tracks.find((t) => t.armed && t.kind !== 'group')
    const g = armed ? this.graphs.get(armed.id) : null
    this.micGain.connect(g ? g.input : this.master.input)
  }

  private buildEvents(project: Project): void {
    this.events = buildEvents(project)
    this.eventsProject = project
    this.eventIdx = 0
  }

  private scheduleBlock(project: Project, bStart: number, bEnd: number, tStart: number): void {
    const spb = 60 / bpmAt(project, bStart)
    const evs = this.events
    const audible = audibleTracks(project)
    let i = this.eventIdx
    while (i > 0 && (evs[i - 1]?.beat ?? -1) >= bStart) i--
    while (i < evs.length && evs[i].beat < bStart) i++
    this.eventIdx = i
    for (; i < evs.length; i++) {
      const ev = evs[i]
      if (ev.beat >= bEnd) break
      const track = project.tracks.find((t) => t.id === ev.trackId)
      if (!track) continue
      const g = this.graphs.get(track.id)
      if (!g || !g.playBus) continue
      if (!audible.has(track.id)) continue
      const time = tStart + (ev.beat - bStart) * spb
      if (time < (this.ctx?.currentTime ?? 0) - 0.05) continue
      if (ev.kind === 'note' && ev.pitch != null) {
        const inst = track.devices.find((d) => !d.bypass && isInstrument(d.type))
        const type: DeviceType = inst?.type ?? (track.kind === 'drum' ? 'drums' : 'synth')
        let params: Params = inst?.params ?? {}
        if (type === 'drums' && inst?.padMap) {
          const pad = inst.padMap[String(ev.pitch)]
          if (pad) {
            params = {
              ...params,
              gain: (params.gain ?? 1) * pad.gain,
              tune: (params.tune ?? 0) + pad.tune,
              decay: (params.decay ?? 1) * pad.decay,
              _pan: pad.pan,
              _cutoff: pad.cutoff,
              _drive: pad.drive,
            }
          }
        }
        playInstrument({
          ctx: this.ctx!,
          type,
          params,
          dest: g.playBus,
          time,
          dur: Math.max(0.02, ev.dur * spb),
          pitch: ev.pitch,
          vel: ev.vel ?? 0.8,
          buffer: inst?.sampleId ? getBuffer(inst.sampleId) : null,
          samplerId: inst?.instrumentId,
        })
      } else {
        this.scheduleAudio(g, track, ev.clip ?? null, time, ev.dur, spb)
      }
    }
    this.applyAutomation(project, bStart, bEnd, tStart, spb)
    if (this.metronome) {
      const perBar = project.timeSig[0] || 4
      const first = Math.ceil(bStart - 1e-9)
      for (let beat = first; beat < bEnd - 1e-9; beat++) {
        if (beat < bStart) continue
        const t = tStart + (beat - bStart) * spb
        this.click(t, Math.abs(beat % perBar) < 1e-9 ? 1 : 0.55)
      }
    }
  }

  private applyAutomation(project: Project, bStart: number, bEnd: number, tStart: number, spb: number): void {
    for (const track of project.tracks) {
      if (!track.automation.length) continue
      const g = this.graphs.get(track.id)
      if (!g) continue
      for (const lane of track.automation) {
        if (lane.points.length < 2) continue
        const v = laneValue(lane.points, bStart)
        if (v == null) continue
        const t = tStart + 0.001
        if (lane.target === 'volume') g.fader.gain.setTargetAtTime(clamp(v, 0, 1.6), t, 0.008)
        else if (lane.target === 'pan') g.pan.pan.setTargetAtTime(clamp(v, -1, 1), t, 0.008)
        else if (lane.target === 'sendA') g.sendA.gain.setTargetAtTime(clamp(v, 0, 1), t, 0.01)
        else if (lane.target === 'sendB') g.sendB.gain.setTargetAtTime(clamp(v, 0, 1), t, 0.01)
        else if (lane.target.startsWith('dev:')) {
          const [, devId, param] = lane.target.split(':')
          const idx = track.devices.filter((d) => !d.bypass && DEVICE_DEFS[d.type].category === 'effect').findIndex((d) => d.id === devId)
          if (idx >= 0) g.fxChain[idx]?.set(param, v)
        }
      }
    }
  }

  private click(time: number, accent: number): void {
    if (!this.ctx || !this.master) return
    const o = this.ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = accent > 0.8 ? 1760 : 1180
    const g = percEnv(this.ctx, this.master.input, time, 0.045, 0.16 * accent, 0.001)
    const f = this.ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = 2400
    o.connect(f).connect(g)
    o.start(time)
    o.stop(time + 0.08)
  }

  private clipBuffer(clip: Clip): AudioBuffer | null {
    if (clip.takes && clip.takes.length && clip.activeTake != null) {
      const take = clip.takes[clip.activeTake]
      const b = getBuffer(take?.assetId)
      if (b) return b
    }
    if (clip.assetId) {
      const b = getBuffer(clip.assetId)
      if (b) return b
    }
    if (clip.libId) {
      const b = getBuffer(clip.libId)
      if (b) return b
      void ensureLibraryBuffer(clip.libId)
    }
    return null
  }

  private scheduleAudio(
    g: TrackGraph,
    track: Track,
    clip: Clip | null,
    time: number,
    durBeats: number,
    spb: number,
  ): void {
    const raw = clip ? this.clipBuffer(clip) : getBuffer(track.frozenAssetId)
    if (!raw || !g.playBus || !this.ctx) return
    let buf = clip?.reverse ? reversedBuffer(this.ctx, raw) : raw
    let targetSec = Math.max(0.02, durBeats * spb)
    let rate = 1
    const contentSec = clip ? Math.max(0.05, clip.contentLen * spb) : buf.duration
    if (clip?.warp?.enabled && clip.kind === 'audio') {
      // Warped audio already matches the project tempo, so it plays at rate 1
      // (pitch is handled inside the warp, not by the playback rate).
      const warped = warpForClip(buf, { projectBpm: this.bpm, clipBeats: clip.contentLen, warp: clip.warp }, this.ctx)
      buf = warped.buffer
      rate = clamp(contentSec / Math.max(0.02, buf.duration), 0.06, 8)
      targetSec = Math.min(targetSec, buf.duration / rate)
    } else {
      rate = clamp(contentSec / Math.max(0.02, buf.duration), 0.06, 8) * Math.pow(2, (clip?.pitch ?? 0) / 12)
    }
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const offsetSec = clip ? clamp(clip.offset * spb * rate, 0, Math.max(0, buf.duration - 0.01)) : 0
    const gain = this.ctx.createGain()
    const level = clip?.gain ?? 1
    const fadeIn = clip ? Math.max(0, clip.fadeIn * spb) : 0
    const fadeOut = clip ? Math.max(0, clip.fadeOut * spb) : 0
    const end = time + targetSec
    gain.gain.setValueAtTime(0, time)
    gain.gain.linearRampToValueAtTime(level, time + Math.min(fadeIn, targetSec * 0.9) + 0.004)
    if (fadeOut > 0.001) {
      gain.gain.setValueAtTime(level, Math.max(time + 0.004, end - fadeOut))
      gain.gain.linearRampToValueAtTime(0, end)
    }
    // Clip envelope: per-clip gain drawn as points over the clip length.
    if (clip?.envelope && clip.envelope.length > 1) {
      gain.gain.cancelScheduledValues(time)
      const span = Math.max(0.02, targetSec)
      for (const point of [...clip.envelope].sort((a, b) => a.beat - b.beat)) {
        const at = time + clamp(point.beat / Math.max(0.01, clip.len), 0, 1) * span
        gain.gain.setValueAtTime(Math.max(0, point.value) * level, at)
      }
    }
    src.connect(gain).connect(g.playBus)
    const playDur = Math.max(0.02, Math.min(buf.duration - offsetSec, targetSec * rate))
    src.start(time, offsetSec, playDur)
  }

  private tick = (): void => {
    const ctx = this.ctx
    if (!ctx || !this.playing || !this.project) return
    const t0 = performance.now()
    const spb = 60 / bpmAt(this.project, this.schedBeat)
    const horizon = ctx.currentTime + LOOKAHEAD
    if (this.project !== this.eventsProject) {
      this.buildEvents(this.project)
    }
    let guard = 0
    while (this.schedTime < horizon && guard++ < 400) {
      const loopOn = this.loop.enabled && this.loop.end > this.loop.start
      const limit = loopOn ? this.loop.end : this.schedBeat + 2
      const blockBeats = Math.max(0.03, 0.07 / spb)
      let end = Math.min(this.schedBeat + blockBeats, limit)
      if (end <= this.schedBeat + 1e-7) {
        this.schedBeat = loopOn ? this.loop.start : this.schedBeat
        this.eventIdx = 0
        this.schedTime += 0.002
        continue
      }
      this.scheduleBlock(this.project, this.schedBeat, end, this.schedTime)
      this.schedTime += (end - this.schedBeat) * spb
      this.schedBeat = end
      if (loopOn && this.schedBeat >= this.loop.end - 1e-6) {
        this.schedBeat = this.loop.start
        this.eventIdx = 0
      }
    }
    this.scheduleLaunches(horizon)
    this.applySidechain()
    const dt = performance.now() - t0
    this.load = this.load * 0.88 + dt * 0.12
  }

  /**
   * Sidechain ducking: follow the source track's level and pull this track's
   * gain down by `depth`. Runs on the scheduler tick (~40 Hz) which is fast
   * enough for kick-driven pumping and costs no extra graph nodes.
   */
  private applySidechain(): void {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx) return
    for (const track of project.tracks) {
      const sc = track.sidechain
      const g = this.graphs.get(track.id)
      if (!g || !sc || !sc.enabled || !sc.sourceId) continue
      const src = this.graphs.get(sc.sourceId)
      if (!src) continue
      const meter = this.readMeter(src.analyser, `sc:${sc.sourceId}`)
      const env = Math.min(1, Math.max(0, meter.rms * 3.4))
      const target = 1 - Math.min(0.98, Math.max(0, sc.depth)) * env
      const tc = target < 1 ? Math.max(0.002, sc.attack) : Math.max(0.01, sc.release)
      g.duck.gain.setTargetAtTime(target, ctx.currentTime, tc)
    }
  }

  /** Current ducking amount for a track, for the mixer meter. */
  duckAmount(trackId: string): number {
    const g = this.graphs.get(trackId)
    return g ? 1 - g.duck.gain.value : 0
  }

  get cpuLoad(): number {
    return Math.min(1, this.load / Math.max(TICK_MS, 1))
  }

  get voiceCount(): number {
    return this.graphs.size + this.liveLaunches.length
  }

  // -------------------------------------------------------------------------
  // session clip launching
  // -------------------------------------------------------------------------
  launchClip(clip: Clip, trackId: string): void {
    if (!this.ctx) return
    const cycleSec = Math.max(0.1, clip.contentLen * (60 / this.bpm))
    this.liveLaunches = this.liveLaunches.filter((l) => l.clipId !== clip.id)
    this.liveLaunches.push({
      clipId: clip.id,
      trackId,
      nextTime: this.ctx.currentTime + 0.06,
      cycleSec,
      clip,
    })
    this.launchedIds.add(clip.id)
  }

  stopLaunch(clipId: string): void {
    this.liveLaunches = this.liveLaunches.filter((l) => l.clipId !== clipId)
    this.launchedIds.delete(clipId)
  }

  stopAllLaunches(): void {
    this.liveLaunches = []
    this.launchedIds.clear()
  }

  private scheduleLaunches(horizon: number): void {
    if (!this.ctx || !this.project) return
    const spb = 60 / this.bpm
    for (const launch of this.liveLaunches) {
      const track = this.project.tracks.find((t) => t.id === launch.trackId)
      if (!track) continue
      const g = this.graphs.get(track.id)
      if (!g) continue
      let guard = 0
      while (launch.nextTime < horizon && guard++ < 4) {
        const t = launch.nextTime
        const clip = launch.clip
        if (clip.kind === 'midi') {
          const inst = track.devices.find((d) => !d.bypass && isInstrument(d.type))
          for (const note of clip.notes) {
            playInstrument({
              ctx: this.ctx,
              type: inst?.type ?? (track.kind === 'drum' ? 'drums' : 'synth'),
              params: inst?.params ?? {},
              dest: g.input,
              time: t + note.start * spb,
              dur: note.len * spb,
              pitch: note.pitch,
              vel: note.vel,
              samplerId: inst?.instrumentId,
            })
          }
        } else {
          this.scheduleAudio(g, track, clip, t, clip.contentLen, spb)
        }
        launch.nextTime += launch.cycleSec
      }
    }
  }

  // -------------------------------------------------------------------------
  // auditioning / previews
  // -------------------------------------------------------------------------
  audition(trackId: string, pitch: number, vel = 0.9, dur = 0.4, drum = false): void {
    if (!this.ctx) return
    const track = this.project?.tracks.find((t) => t.id === trackId)
    const g = this.graphs.get(trackId)
    if (!track || !g) return
    const inst = track.devices.find((d) => !d.bypass && isInstrument(d.type))
    playInstrument({
      ctx: this.ctx,
      type: inst?.type ?? (drum || track.kind === 'drum' ? 'drums' : 'synth'),
      params: inst?.params ?? defaultParams('synth'),
      dest: g.input,
      time: this.ctx.currentTime + 0.01,
      dur,
      pitch,
      vel,
      buffer: inst?.sampleId ? getBuffer(inst.sampleId) : null,
      samplerId: inst?.instrumentId,
    })
  }

  previewPhrase(
    type: DeviceType,
    params: Params,
    pitches = [60, 64, 67, 72],
    dur = 0.45,
    gap = 0.16,
    effect?: { type: DeviceType; params: Params },
    samplerId?: string,
  ): void {
    if (!this.ctx || !this.master) return
    const now = this.ctx.currentTime + 0.06
    const dest = gainNode(this.ctx, 0.9)
    if (effect) {
      const fx = createEffect(this.ctx, effect.type, effect.params)
      fx.output.connect(this.master.input)
      dest.connect(fx.input)
    } else {
      dest.connect(this.master.input)
    }
    pitches.forEach((pitch, i) => {
      playInstrument({
        ctx: this.ctx!,
        type,
        params,
        dest,
        time: now + i * (dur + gap),
        dur,
        pitch,
        vel: 0.8,
        samplerId,
      })
    })
  }

  previewNotes(
    type: DeviceType,
    params: Params,
    notes: { pitch: number; start: number; len: number; vel: number }[],
    bpm: number,
    samplerId?: string,
  ): void {
    if (!this.ctx || !this.master) return
    const now = this.ctx.currentTime + 0.06
    const spb = 60 / bpm
    const dest = gainNode(this.ctx, 0.9)
    dest.connect(this.master.input)
    for (const note of notes) {
      playInstrument({
        ctx: this.ctx,
        type,
        params,
        dest,
        time: now + note.start * spb,
        dur: Math.max(0.05, note.len * spb),
        pitch: note.pitch,
        vel: note.vel,
        samplerId,
      })
    }
  }

  /** A short chord so the user can confirm audio really reaches the speakers. */
  testTone(): boolean {
    if (!this.ctx || !this.master) return false
    const t = this.ctx.currentTime + 0.05
    const notes = [261.63, 329.63, 392.0, 523.25]
    notes.forEach((f, i) => {
      const osc = this.ctx!.createOscillator()
      osc.type = i === 3 ? 'triangle' : 'sine'
      osc.frequency.value = f
      const g = gainNode(this.ctx!, 0)
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.18, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5 + i * 0.04)
      osc.connect(g).connect(this.master!.input)
      osc.start(t)
      osc.stop(t + 1.7)
    })
    return true
  }

  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      return all.filter((d) => d.kind === 'audioinput')
    } catch {
      return []
    }
  }

  micDeviceId: string | null = null

  async switchMic(deviceId: string | null): Promise<MicStatus> {
    this.disableMic()
    return this.enableMic(deviceId)
  }

  /** Load an impulse response for the master convolution reverb. */
  async setImpulseResponse(buf: AudioBuffer | null): Promise<void> {
    if (!this.master) return
    this.master.convolver.buffer = buf ?? impulseResponse(this.ctx!, 2.8, 0.45, 0.6)
  }

  async importImpulseResponse(file: File): Promise<{ ok: boolean; message: string }> {
    try {
      const ctx = await this.start()
      const arr = await file.arrayBuffer()
      const buf = await ctx.decodeAudioData(arr)
      await this.setImpulseResponse(buf)
      const { storedFromBuffer } = await import('./assets')
      const { db } = await import('../state/db')
      await db.setKV('impulseResponse', { ...storedFromBuffer(file.name, buf), name: file.name })
      this.irName = file.name
      return { ok: true, message: `Reverb impulse “${file.name}” loaded (${buf.duration.toFixed(2)}s)` }
    } catch {
      return { ok: false, message: 'That file could not be decoded as an impulse response. Try a WAV or AIFF.' }
    }
  }

  irName: string | null = null

  async restoreImpulseResponse(): Promise<string | null> {
    try {
      const { db } = await import('../state/db')
      const stored = await db.getKV<import('../state/db').StoredAsset>('impulseResponse')
      if (!stored) return null
      const { bufferFromStored } = await import('./assets')
      const ctx = await this.start()
      const buf = bufferFromStored(ctx, stored)
      await this.setImpulseResponse(buf)
      this.irName = stored.name
      return stored.name
    } catch {
      return null
    }
  }

  previewBuffer(buf: AudioBuffer, gain = 0.9): void {
    if (!this.ctx || !this.master) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    const g = gainNode(this.ctx, gain)
    src.connect(g).connect(this.master.input)
    src.start()
  }

  playSample(pitch: number, velocity = 0.9): void {
    if (!this.ctx || !this.master) return
    playInstrument({
      ctx: this.ctx,
      type: 'drums',
      params: { kit: 0 },
      dest: this.master.input,
      time: this.ctx.currentTime + 0.005,
      dur: 0.3,
      pitch,
      vel: velocity,
    })
  }

  // -------------------------------------------------------------------------
  // metering
  // -------------------------------------------------------------------------
  /** Master chain processing (glue / EQ / limiter) and loudness target. */
  setMasterChain(chain: MasterChain): void {
    if (!this.master || !this.ctx) return
    const m = this.master
    const t = this.ctx.currentTime
    const eq = chain.eqGains ?? null
    m.eqLow.gain.setTargetAtTime(chain.eq ? (eq ? eq.low : 0.6) : 0, t, 0.05)
    m.eqMid.gain.setTargetAtTime(chain.eq ? (eq ? eq.mid : -0.8) : 0, t, 0.05)
    m.eqHigh.gain.setTargetAtTime(chain.eq ? (eq ? eq.high : 1.2) : 0, t, 0.05)
    m.glue.ratio.setTargetAtTime(chain.glue ? 2 : 1, t, 0.05)
    m.glue.threshold.setTargetAtTime(chain.glue ? -14 : 0, t, 0.05)
    if (chain.limiter) {
      m.limiter.threshold.setTargetAtTime(-1.2, t, 0.05)
      m.limiter.ratio.setTargetAtTime(20, t, 0.05)
    } else {
      m.limiter.threshold.setTargetAtTime(0, t, 0.05)
      m.limiter.ratio.setTargetAtTime(1, t, 0.05)
    }
    const width = Math.max(0, Math.min(2, chain.width ?? 1))
    this.widthL?.gain.setTargetAtTime(width, t, 0.05)
    this.widthR?.gain.setTargetAtTime(width, t, 0.05)
    this.masterChain = chain
  }

  masterChain: MasterChain = { glue: true, eq: true, limiter: true, target: -14 }
  private widthL: GainNode | null = null
  private widthR: GainNode | null = null

  /** Play a slice of an audio buffer (sample editor pads). */
  previewSlice(buffer: AudioBuffer, offsetSec: number, durSec: number, rate = 1, gain = 0.9): void {
    if (!this.ctx || !this.master) return
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = Math.max(0.25, Math.min(4, rate))
    const g = gainNode(this.ctx, 0)
    const t = this.ctx.currentTime + 0.01
    const d = Math.max(0.03, Math.min(durSec, buffer.duration - offsetSec))
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.005)
    g.gain.setValueAtTime(gain, t + Math.max(0.01, d - 0.02))
    g.gain.exponentialRampToValueAtTime(0.0001, t + d)
    src.connect(g).connect(this.master.input)
    src.start(t, Math.max(0, offsetSec), d)
    src.stop(t + d + 0.05)
  }

  setReturnPreset(id: ReturnPresetId): void {
    if (!this.master || !this.ctx) return
    const m = this.master
    const t = this.ctx.currentTime
    const spb = 60 / this.bpm
    if (id === 'plate') {
      m.delayL.delayTime.setTargetAtTime(spb * 0.5, t, 0.05)
      m.delayR.delayTime.setTargetAtTime(spb * 0.75, t, 0.05)
      m.delayFb.gain.setTargetAtTime(0.12, t, 0.05)
      m.convolver.buffer = impulseResponse(this.ctx, 1.8, 0.55, 0.5)
    } else if (id === 'hall') {
      m.delayL.delayTime.setTargetAtTime(spb, t, 0.05)
      m.delayR.delayTime.setTargetAtTime(spb * 1.5, t, 0.05)
      m.delayFb.gain.setTargetAtTime(0.3, t, 0.05)
      m.convolver.buffer = impulseResponse(this.ctx, 4.5, 0.3, 0.7)
    } else if (id === 'slap') {
      m.delayL.delayTime.setTargetAtTime(0.085, t, 0.05)
      m.delayR.delayTime.setTargetAtTime(0.13, t, 0.05)
      m.delayFb.gain.setTargetAtTime(0.05, t, 0.05)
      m.convolver.buffer = impulseResponse(this.ctx, 1.2, 0.6, 0.5)
    } else {
      m.delayL.delayTime.setTargetAtTime(spb * 0.75, t, 0.05)
      m.delayR.delayTime.setTargetAtTime(spb * 1.5, t, 0.05)
      m.delayFb.gain.setTargetAtTime(0.55, t, 0.05)
      m.convolver.buffer = impulseResponse(this.ctx, 2.2, 0.5, 0.4)
    }
    this.returnPreset = id
  }

  returnPreset: ReturnPresetId = 'plate'

  /** Fill two buffers with the master's left/right waveform (phase scope). */
  masterStereo(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>): boolean {
    if (!this.master) return false
    const m = this.master
    if (left.length !== m.analyserL.fftSize || right.length !== m.analyserR.fftSize) return false
    m.analyserL.getFloatTimeDomainData(left)
    m.analyserR.getFloatTimeDomainData(right)
    return true
  }

  /** Short-term master loudness in LUFS (K-weighted, stereo). */
  masterLufs(): number {
    if (!this.master) return -Infinity
    const m = this.master
    const l = new Float32Array(m.analyserL.fftSize)
    const r = new Float32Array(m.analyserR.fftSize)
    m.analyserL.getFloatTimeDomainData(l)
    m.analyserR.getFloatTimeDomainData(r)
    return lufsFromAnalyser(l, r, this.ctx?.sampleRate ?? 48000)
  }

  private readMeter(analyser: AnalyserNode, key: string): { peak: number; rms: number } {
    let buf = this.meterBufs.get(key)
    if (!buf || buf.length !== analyser.fftSize) {
      buf = new Float32Array(analyser.fftSize)
      this.meterBufs.set(key, buf)
    }
    analyser.getFloatTimeDomainData(buf)
    let peak = 0
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i])
      if (v > peak) peak = v
      sum += buf[i] * buf[i]
    }
    return { peak, rms: Math.sqrt(sum / buf.length) }
  }

  trackMeter(id: string): { peak: number; rms: number } {
    const g = this.graphs.get(id)
    if (!g) return { peak: 0, rms: 0 }
    return this.readMeter(g.analyser, `t:${id}`)
  }

  masterMeter(): { peak: number; rms: number } {
    if (!this.master) return { peak: 0, rms: 0 }
    return this.readMeter(this.master.analyser, 'master')
  }

  spectrum(target: Uint8Array): void {
    if (!this.master) return
    this.master.analyser.getByteFrequencyData(target as Uint8Array<ArrayBuffer>)
  }

  effectReduction(trackId: string, deviceId: string): number {
    const g = this.graphs.get(trackId)
    if (!g) return 0
    const track = this.project?.tracks.find((t) => t.id === trackId)
    if (!track) return 0
    const effects = track.devices.filter((d) => !d.bypass && DEVICE_DEFS[d.type].category === 'effect')
    const idx = effects.findIndex((d) => d.id === deviceId)
    if (idx < 0) return 0
    return g.fxChain[idx]?.info?.('reduction') ?? 0
  }

  // -------------------------------------------------------------------------
  // microphone + recording
  // -------------------------------------------------------------------------
  async enableMic(deviceId?: string | null): Promise<MicStatus> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ready: false, error: 'This browser has no microphone support. Use MIDI or the on-screen keyboard instead.', level: 0 }
    }
    try {
      const ctx = await this.start()
      if (this.micStream) return { ready: true, level: 0 }
      const chosen = deviceId === undefined ? this.micDeviceId : deviceId
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          ...(chosen ? { deviceId: { exact: chosen } } : {}),
        },
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch (inner) {
        if (chosen && inner instanceof DOMException && inner.name === 'OverconstrainedError') {
          // The remembered device is gone: fall back to the system default.
          this.micDeviceId = null
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } else {
          throw inner
        }
      }
      this.micStream = stream
      const actual = stream.getAudioTracks()[0]?.getSettings?.().deviceId
      if (actual) this.micDeviceId = actual
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      const g = gainNode(ctx, 1)
      src.connect(analyser)
      src.connect(g)
      this.micSource = src
      this.micAnalyser = analyser
      this.micGain = g
      this.rewireMic()
      return { ready: true, level: 0 }
    } catch (err) {
      const msg =
        err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
          ? 'Microphone blocked. Click the padlock in the address bar, allow the microphone for this site, then press Record again.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No microphone found. Plug in an input device and pick it in Settings → Audio input.'
            : err instanceof DOMException && err.name === 'NotReadableError'
              ? 'Another app is using the microphone. Close it, then press Record again.'
              : 'Could not open the microphone. Everything else still works — you can record MIDI and use the virtual keyboard.'
      return { ready: false, error: msg, level: 0 }
    }
  }

  disableMic(): void {
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
    this.micSource = null
    this.micAnalyser = null
    this.micGain = null
  }

  micLevel(): number {
    if (!this.micAnalyser) return 0
    const buf = new Float32Array(this.micAnalyser.fftSize)
    this.micAnalyser.getFloatTimeDomainData(buf)
    let peak = 0
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
    return peak
  }

  micWaveform(target: Float32Array<ArrayBuffer>): boolean {
    if (!this.micAnalyser) return false
    if (target.length !== this.micAnalyser.fftSize) return false
    this.micAnalyser.getFloatTimeDomainData(target)
    return true
  }

  startCapture(): boolean {
    if (!this.micStream || typeof MediaRecorder === 'undefined') return false
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
    let mimeType = ''
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) {
        mimeType = t
        break
      }
    }
    try {
      this.recChunks = []
      this.recorder = new MediaRecorder(this.micStream, mimeType ? { mimeType } : undefined)
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.recChunks.push(e.data)
      }
      this.recorder.start(200)
      return true
    } catch {
      this.recorder = null
      return false
    }
  }

  async stopCapture(): Promise<AudioBuffer | null> {
    const rec = this.recorder
    if (!rec) return null
    const chunks = this.recChunks
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
      try {
        rec.stop()
      } catch {
        resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
      }
    })
    this.recorder = null
    this.recChunks = []
    if (!blob.size) return null
    return this.decodeRecording(blob)
  }

  private async decodeRecording(blob: Blob): Promise<AudioBuffer | null> {
    if (!this.ctx) return null
    try {
      const arr = await blob.arrayBuffer()
      return await this.ctx.decodeAudioData(arr)
    } catch {
      try {
        const tmp = new OfflineAudioContext(1, 1, 44100)
        const arr = await blob.arrayBuffer()
        return await tmp.decodeAudioData(arr)
      } catch {
        return null
      }
    }
  }

  /** Offline render of a single track, used by track freeze. */
  async renderTrackOnly(trackId: string): Promise<AudioBuffer | null> {
    if (!this.project) return null
    const mod = await import('./render')
    return mod.renderTrackBuffer(this.project, trackId)
  }

  async freezeTrack(trackId: string): Promise<AudioBuffer | null> {
    return this.renderTrackOnly(trackId)
  }
}

export function laneValue(points: { beat: number; value: number }[], beat: number): number | null {
  if (!points.length) return null
  const sorted = points
  if (beat <= sorted[0].beat) return sorted[0].value
  if (beat >= sorted[sorted.length - 1].beat) return sorted[sorted.length - 1].value
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (beat >= a.beat && beat <= b.beat) {
      const t = (beat - a.beat) / Math.max(1e-6, b.beat - a.beat)
      return a.value + (b.value - a.value) * t
    }
  }
  return sorted[sorted.length - 1].value
}

export const engine = new AudioEngine()
export { noiseBuffer, safeFreq }
