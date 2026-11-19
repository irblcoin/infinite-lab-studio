import type { DeviceType, Params } from '../state/types'
import { SCALES } from '../state/types'
import {
  biquad,
  crushCurve,
  dbToGain,
  distCurve,
  gainNode,
  gateCurve,
  impulseResponse,
  shaper,
} from './dsp'

export interface FXNode {
  type: DeviceType
  input: GainNode
  output: GainNode
  set: (key: string, value: number) => void
  /** Extra live readout for the UI (compressor reduction, etc.). */
  info?: (key: string) => number
  dispose: () => void
}

interface Shell {
  input: GainNode
  dry: GainNode
  wet: GainNode
  output: GainNode
  mixKey: string
}

function makeShell(ctx: BaseAudioContext, mixParam = 'mix'): Shell {
  const input = gainNode(ctx, 1)
  const output = gainNode(ctx, 1)
  const dry = gainNode(ctx, 1)
  const wet = gainNode(ctx, 0)
  input.connect(dry).connect(output)
  wet.connect(output)
  return { input, dry, wet, output, mixKey: mixParam }
}

function setMix(shell: Shell, value: number): void {
  const m = Math.max(0, Math.min(1, value))
  shell.dry.gain.value = 1 - m
  shell.wet.gain.value = m
}

/** Build a device's audio processing chain. */
export function createEffect(
  ctx: BaseAudioContext,
  type: DeviceType,
  params: Params,
): FXNode {
  const shell = makeShell(ctx)
  const cleanup: (() => void)[] = []
  let setter: (key: string, value: number) => void = () => {}

  const p = (k: string, d = 0): number => (params[k] ?? d)

  switch (type) {
    case 'resonator': {
      // Seven tuned comb resonators (Karplus–Strong style).
      setMix(shell, p('mix', 0.55))
      const count = Math.max(3, Math.min(8, Math.round(p('partials', 6))))
      const rootHz = 440 * Math.pow(2, ((p('root', 48) - 69) / 12))
      const spread = p('spread', 1.4)
      const decay = Math.max(0.05, p('decay', 0.9))
      const damp = biquad(ctx, 'lowpass', p('damp', 5200), 0.8)
      damp.connect(shell.wet)
      const combs: { delay: DelayNode; fb: GainNode; tune: (hz: number) => void }[] = []
      for (let i = 0; i < count; i++) {
        const delay = ctx.createDelay(2)
        const fb = gainNode(ctx, 0.75)
        const ratio = Math.pow(i + 1, spread / 2)
        const tune = (hz: number) => {
          const f = Math.max(30, Math.min(ctx.sampleRate / 2 - 100, hz * ratio))
          delay.delayTime.value = Math.min(1.9, 1 / f)
        }
        tune(rootHz)
        shell.input.connect(delay)
        delay.connect(fb).connect(delay)
        delay.connect(damp)
        combs.push({ delay, fb, tune })
      }
      setter = (k, v) => {
        if (k === 'root') combs.forEach((c) => c.tune(440 * Math.pow(2, ((v - 69) / 12))))
        if (k === 'decay') combs.forEach((c) => (c.fb.gain.value = Math.min(0.97, 0.35 + (v / 4) * 0.55)))
        if (k === 'damp') damp.frequency.value = v
        if (k === 'mix') setMix(shell, v)
      }
      combs.forEach((c) => (c.fb.gain.value = Math.min(0.97, 0.35 + (decay / 4) * 0.55)))
      break
    }
    case 'vocoder': {
      // Band-split modulator + internal carrier = classic robot vocoder.
      setMix(shell, p('mix', 0.85))
      const bands = Math.max(4, Math.min(16, Math.round(p('bands', 10))))
      const release = Math.max(0.01, p('release', 0.1))
      const formant = Math.pow(2, p('formant', 0) / 12)
      const carrierType: OscillatorType = p('carrier', 0) === 1 ? 'square' : p('carrier', 0) === 2 ? 'sawtooth' : 'sawtooth'
      const carrier = ctx.createOscillator()
      carrier.type = carrierType
      carrier.frequency.value = 110 * formant
      const carrierGain = gainNode(ctx, 0)
      carrier.connect(carrierGain)
      const bandNodes: { filter: BiquadFilterNode; analyser: AnalyserNode; gain: GainNode; buf: Float32Array }[] = []
      const bandData = new Uint8Array(32)
      for (let i = 0; i < bands; i++) {
        const f = 180 * Math.pow(2, (i / bands) * 5.4) * formant
        const filter = ctx.createBiquadFilter()
        filter.type = 'bandpass'
        filter.frequency.value = Math.min(ctx.sampleRate / 2 - 200, f)
        filter.Q.value = 6
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 64
        const gain = gainNode(ctx, 0)
        shell.input.connect(filter).connect(analyser)
        carrierGain.connect(gain).connect(shell.wet)
        bandNodes.push({ filter, analyser, gain, buf: bandData as unknown as Float32Array })
      }
      carrierGain.gain.value = 0.5
      carrier.start()
      const timer = window.setInterval(() => {
        for (const band of bandNodes) {
          band.analyser.getByteFrequencyData(bandData)
          let sum = 0
          for (let i = 0; i < bandData.length; i++) sum += bandData[i]
          const level = Math.min(1, sum / bandData.length / 120)
          band.gain.gain.setTargetAtTime(level, ctx.currentTime, release)
        }
      }, 45)
      cleanup.push(() => {
        window.clearInterval(timer)
        try {
          carrier.stop()
        } catch {
          /* already stopped */
        }
      })
      setter = (k, v) => {
        if (k === 'mix') setMix(shell, v)
        if (k === 'release') return
        if (k === 'formant') carrier.frequency.value = 110 * Math.pow(2, v / 12)
      }
      break
    }
    case 'spectral': {
      // Spectral smear: a bank of band-passes crossfaded by a slow LFO with a
      // feedback tail, freezing transients into glass.
      setMix(shell, p('mix', 0.5))
      const blur = p('blur', 0.6)
      const motion = p('motion', 0.3)
      const feedback = Math.max(0, Math.min(0.92, p('feedback', 0.45)))
      const shift = Math.pow(2, p('shift', 0) / 12)
      const count = 12
      const bank = gainNode(ctx, 0.18)
      const fbIn = gainNode(ctx, feedback)
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 0.05 + motion * 0.8
      const lfoAmt = gainNode(ctx, 0)
      lfo.connect(lfoAmt)
      for (let i = 0; i < count; i++) {
        const f = 90 * Math.pow(2, (i / count) * 6.4) * shift
        const bp = biquad(ctx, 'bandpass', Math.min(ctx.sampleRate / 2 - 200, f), 2.5 + blur * 8)
        const g = gainNode(ctx, 0.16)
        lfoAmt.connect(g.gain)
        shell.input.connect(bp).connect(g).connect(bank)
      }
      bank.connect(shell.wet)
      bank.connect(fbIn).connect(shell.input)
      lfoAmt.gain.value = 0.3 * motion
      lfo.start()
      cleanup.push(() => {
        try {
          lfo.stop()
        } catch {
          /* ignore */
        }
      })
      setter = (k, v) => {
        if (k === 'mix') setMix(shell, v)
        if (k === 'feedback') fbIn.gain.value = v
        if (k === 'motion') lfoAmt.gain.value = v * 0.4
      }
      break
    }
    case 'looper': {
      setMix(shell, p('mix', 0.7))
      let node: AudioWorkletNode | null = null
      try {
        if (typeof AudioWorkletNode !== 'undefined') {
          node = new AudioWorkletNode(ctx as BaseAudioContext, 'ils-looper', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          })
          node.parameters.get('length')!.value = p('length', 2)
          node.parameters.get('feedback')!.value = p('feedback', 0.6)
          node.parameters.get('speed')!.value = p('speed', 1)
          node.parameters.get('mix')!.value = 0.85
          shell.input.connect(node).connect(shell.wet)
        }
      } catch {
        node = null
      }
      if (!node) {
        // Fallback for browsers without worklets: feedback delay loop.
        const delay = ctx.createDelay(8)
        delay.delayTime.value = Math.min(4, p('length', 2))
        const fb = gainNode(ctx, p('feedback', 0.6))
        shell.input.connect(delay)
        delay.connect(fb).connect(delay)
        delay.connect(shell.wet)
        setter = (k, v) => {
          if (k === 'mix') setMix(shell, v)
          if (k === 'length') delay.delayTime.value = Math.min(4, v)
          if (k === 'feedback') fb.gain.value = v
        }
      } else {
        const ref = node
        setter = (k, v) => {
          if (k === 'mix') setMix(shell, v)
          const param = ref.parameters.get(k)
          if (param) param.value = v
        }
      }
      break
    }
    case 'eq3': {
      setMix(shell, 1)
      const low = biquad(ctx, 'lowshelf', p('lowFreq', 120))
      const mid = biquad(ctx, 'peaking', p('midFreq', 1200), p('midQ', 1))
      const high = biquad(ctx, 'highshelf', p('highFreq', 8000))
      low.gain.value = p('lowGain')
      mid.gain.value = p('midGain')
      high.gain.value = p('highGain')
      shell.input.connect(low).connect(mid).connect(high).connect(shell.wet)
      setter = (k, v) => {
        if (k === 'lowGain') low.gain.value = v
        else if (k === 'lowFreq') low.frequency.value = v
        else if (k === 'midGain') mid.gain.value = v
        else if (k === 'midFreq') mid.frequency.value = v
        else if (k === 'midQ') mid.Q.value = v
        else if (k === 'highGain') high.gain.value = v
        else if (k === 'highFreq') high.frequency.value = v
      }
      break
    }
    case 'comp':
    case 'limiter': {
      const comp = ctx.createDynamicsCompressor()
      const makeup = gainNode(ctx, 1)
      comp.threshold.value = type === 'limiter' ? (p('ceiling', -0.3) - 1.5) : p('threshold', -18)
      comp.ratio.value = type === 'limiter' ? 20 : p('ratio', 3.5)
      comp.attack.value = type === 'limiter' ? 0.001 : p('attack', 0.008)
      comp.release.value = p('release', 0.2)
      comp.knee.value = type === 'limiter' ? 0 : p('knee', 12)
      makeup.gain.value = type === 'limiter' ? 1 : dbToGain(p('makeup'))
      shell.input.connect(comp).connect(makeup).connect(shell.wet)
      setMix(shell, type === 'limiter' ? 1 : p('mix', 1))
      setter = (k, v) => {
        if (k === 'threshold') comp.threshold.value = v
        else if (k === 'ratio') comp.ratio.value = v
        else if (k === 'attack') comp.attack.value = v
        else if (k === 'release') comp.release.value = v
        else if (k === 'knee') comp.knee.value = v
        else if (k === 'makeup') makeup.gain.value = dbToGain(v)
        else if (k === 'ceiling') comp.threshold.value = v - 1.5
        else if (k === 'mix') setMix(shell, v)
      }
      return {
        type,
        input: shell.input,
        output: shell.output,
        set: (k, v) => setter(k, v),
        info: () => comp.reduction || 0,
        dispose: () => {
          try {
            comp.disconnect()
          } catch {
            /* noop */
          }
        },
      }
    }
    case 'gate': {
      setMix(shell, p('mix', 1))
      const ws = shaper(ctx, gateCurve(p('threshold', -46)))
      shell.input.connect(ws).connect(shell.wet)
      setter = (k, v) => {
        if (k === 'threshold') ws.curve = gateCurve(v)
        else if (k === 'mix') setMix(shell, v)
      }
      break
    }
    case 'reverb': {
      setMix(shell, p('mix', 0.28))
      const predelay = ctx.createDelay(0.3)
      predelay.delayTime.value = p('predelay', 0.02)
      const hp = biquad(ctx, 'highpass', Math.max(20, p('lowcut', 120)), 0.7)
      const conv = ctx.createConvolver()
      let ir = impulseResponse(ctx, p('decay', 2.4), p('damp', 0.45), p('size', 0.55))
      conv.buffer = ir
      const out = gainNode(ctx, 0.9)
      shell.input.connect(predelay).connect(hp).connect(conv).connect(out).connect(shell.wet)
      let pending = 0
      setter = (k, v) => {
        if (k === 'predelay') predelay.delayTime.value = v
        else if (k === 'lowcut') hp.frequency.value = v
        else if (k === 'mix') setMix(shell, v)
        else if (k === 'size' || k === 'decay' || k === 'damp') {
          if (pending) clearTimeout(pending)
          pending = window.setTimeout(() => {
            ir = impulseResponse(
              ctx,
              k === 'decay' ? v : p('decay', 2.4),
              k === 'damp' ? v : p('damp', 0.45),
              k === 'size' ? v : p('size', 0.55),
            )
            conv.buffer = ir
          }, 120)
        }
      }
      cleanup.push(() => pending && clearTimeout(pending))
      break
    }
    case 'delay': {
      setMix(shell, p('mix', 0.24))
      const dl = ctx.createDelay(2.5)
      const dr = ctx.createDelay(2.5)
      const fb = gainNode(ctx, p('feedback', 0.34))
      const tone = biquad(ctx, 'lowpass', p('tone', 5200), 0.7)
      const ping = p('ping', 1) > 0.5
      dl.delayTime.value = p('time', 0.5)
      dr.delayTime.value = p('time', 0.5)
      shell.input.connect(dl)
      if (ping) {
        dl.connect(dr)
        dr.connect(tone).connect(fb).connect(dl)
        const merger = ctx.createChannelMerger(2)
        dl.connect(merger, 0, 0)
        dr.connect(merger, 0, 1)
        merger.connect(shell.wet)
      } else {
        dl.connect(tone).connect(fb).connect(dl)
        dl.connect(shell.wet)
      }
      setter = (k, v) => {
        if (k === 'time') {
          dl.delayTime.value = v
          dr.delayTime.value = v
        } else if (k === 'feedback') fb.gain.value = Math.min(0.92, v)
        else if (k === 'tone') tone.frequency.value = v
        else if (k === 'mix') setMix(shell, v)
      }
      break
    }
    case 'chorus':
    case 'flanger': {
      setMix(shell, p('mix', 0.35))
      const isFlange = type === 'flanger'
      const left = ctx.createDelay(0.1)
      const right = ctx.createDelay(0.1)
      const base = isFlange ? 0.004 : 0.019
      left.delayTime.value = base
      right.delayTime.value = base * 1.3
      const lfoL = ctx.createOscillator()
      const lfoR = ctx.createOscillator()
      lfoL.type = lfoR.type = 'sine'
      lfoL.frequency.value = p('rate', 0.55)
      lfoR.frequency.value = p('rate', 0.55) * 1.13
      const gL = gainNode(ctx, p('depth', 0.006))
      const gR = gainNode(ctx, p('depth', 0.006) * (0.5 + p('spread', 0.7)))
      lfoL.connect(gL).connect(left.delayTime)
      lfoR.connect(gR).connect(right.delayTime)
      const split = ctx.createChannelSplitter(2)
      const merger = ctx.createChannelMerger(2)
      shell.input.connect(split)
      split.connect(left, 0)
      split.connect(right, 1)
      left.connect(merger, 0, 0)
      right.connect(merger, 0, 1)
      merger.connect(shell.wet)
      let fbNode: GainNode | null = null
      if (isFlange) {
        fbNode = gainNode(ctx, Math.min(0.9, p('feedback', 0.55)))
        merger.connect(fbNode).connect(left)
      }
      lfoL.start()
      lfoR.start()
      cleanup.push(() => {
        try {
          lfoL.stop()
          lfoR.stop()
        } catch {
          /* noop */
        }
      })
      setter = (k, v) => {
        if (k === 'rate') {
          lfoL.frequency.value = v
          lfoR.frequency.value = v * 1.13
        } else if (k === 'depth') {
          gL.gain.value = v
          gR.gain.value = v * (0.5 + p('spread', 0.7))
          if (isFlange) {
            left.delayTime.value = 0.004
          }
        } else if (k === 'mix') setMix(shell, v)
        else if (k === 'feedback' && fbNode) fbNode.gain.value = Math.min(0.9, v)
      }
      break
    }
    case 'phaser': {
      setMix(shell, p('mix', 0.45))
      const stages = Math.max(2, Math.min(8, Math.round(p('stages', 4))))
      const filters: BiquadFilterNode[] = []
      let node: AudioNode = shell.input
      for (let i = 0; i < stages; i++) {
        const f = biquad(ctx, 'allpass', 500 + i * 420, 0.7)
        node.connect(f)
        node = f
        filters.push(f)
      }
      const fb = gainNode(ctx, p('feedback', 0.4))
      node.connect(fb)
      fb.connect(filters[0])
      node.connect(shell.wet)
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = p('rate', 0.3)
      const depth = gainNode(ctx, 700 * p('depth', 0.7))
      lfo.connect(depth)
      for (const f of filters) depth.connect(f.frequency)
      lfo.start()
      cleanup.push(() => {
        try {
          lfo.stop()
        } catch {
          /* noop */
        }
      })
      setter = (k, v) => {
        if (k === 'rate') lfo.frequency.value = v
        else if (k === 'depth') depth.gain.value = 700 * v
        else if (k === 'feedback') fb.gain.value = Math.min(0.9, v)
        else if (k === 'mix') setMix(shell, v)
      }
      break
    }
    case 'distortion': {
      setMix(shell, p('mix', 1))
      const ws = shaper(ctx, distCurve(1 + p('drive', 6), p('bias', 0)))
      const tone = biquad(ctx, 'lowpass', p('tone', 4800), 0.8)
      const out = gainNode(ctx, p('output', 0.8))
      shell.input.connect(ws).connect(tone).connect(out).connect(shell.wet)
      setter = (k, v) => {
        if (k === 'drive') ws.curve = distCurve(1 + v * 2, p('bias', 0))
        else if (k === 'bias') ws.curve = distCurve(1 + p('drive', 6) * 2, v)
        else if (k === 'tone') tone.frequency.value = v
        else if (k === 'output') out.gain.value = v
        else if (k === 'mix') setMix(shell, v)
      }
      break
    }
    case 'bitcrush': {
      setMix(shell, p('mix', 0.6))
      const ws = shaper(ctx, crushCurve(p('bits', 6)))
      const lp = biquad(ctx, 'lowpass', 18000 - p('crush', 0.35) * 15000, 0.9)
      const drv = gainNode(ctx, 1 + p('drive', 0.2) * 2)
      shell.input.connect(drv).connect(ws).connect(lp).connect(shell.wet)
      setter = (k, v) => {
        if (k === 'bits') ws.curve = crushCurve(v)
        else if (k === 'crush') lp.frequency.value = Math.max(400, 18000 - v * 15000)
        else if (k === 'drive') drv.gain.value = 1 + v * 2
        else if (k === 'mix') setMix(shell, v)
      }
      break
    }
    case 'autofilter': {
      setMix(shell, p('mix', 1))
      const f = biquad(
        ctx,
        p('mode') === 1 ? 'highpass' : p('mode') === 2 ? 'bandpass' : 'lowpass',
        p('freq', 1400),
        p('res', 6),
      )
      shell.input.connect(f).connect(shell.wet)
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = p('lfoRate', 0.35)
      const lg = gainNode(ctx, p('freq', 1400) * p('lfoAmt', 0.3))
      lfo.connect(lg).connect(f.frequency)
      lfo.start()
      cleanup.push(() => {
        try {
          lfo.stop()
        } catch {
          /* noop */
        }
      })
      setter = (k, v) => {
        if (k === 'freq') {
          f.frequency.value = v
          lg.gain.value = v * p('lfoAmt', 0.3)
        } else if (k === 'res') f.Q.value = v
        else if (k === 'lfoRate') lfo.frequency.value = v
        else if (k === 'lfoAmt') lg.gain.value = p('freq', 1400) * v
        else if (k === 'mode') f.type = v === 1 ? 'highpass' : v === 2 ? 'bandpass' : 'lowpass'
        else if (k === 'mix') setMix(shell, v)
      }
      break
    }
    case 'pitchshift': {
      setMix(shell, p('mix', 0.6))
      const windowS = Math.max(0.02, p('window', 0.07))
      const speedFor = (semis: number) => Math.max(0.2, Math.abs(1 - Math.pow(2, semis / 12)) / windowS)
      const build = (offset: number, sign: number) => {
        const d = ctx.createDelay(0.5)
        const lfo = ctx.createOscillator()
        lfo.type = 'sawtooth'
        lfo.frequency.value = speedFor(p('semitones'))
        const depth = gainNode(ctx, windowS)
        d.delayTime.value = windowS + 0.012 + offset
        lfo.connect(depth).connect(d.delayTime)
        const fade = ctx.createGain()
        const fadeLfo = ctx.createOscillator()
        fadeLfo.type = 'sine'
        fadeLfo.frequency.value = Math.max(0.15, speedFor(p('semitones')) / 2)
        const fg = gainNode(ctx, sign * 0.5)
        fadeLfo.connect(fg).connect(fade.gain)
        fade.gain.value = 0.5
        shell.input.connect(d).connect(fade).connect(shell.wet)
        lfo.start()
        fadeLfo.start()
        cleanup.push(() => {
          try {
            lfo.stop()
            fadeLfo.stop()
          } catch {
            /* noop */
          }
        })
        return { lfo, fadeLfo }
      }
      const a = build(0, 1)
      const b = build(windowS * 0.5, -1)
      setter = (k, v) => {
        if (k === 'mix') setMix(shell, v)
        else if (k === 'semitones' || k === 'window') {
          const sp = k === 'window' ? Math.max(0.2, Math.abs(1 - Math.pow(2, p('semitones') / 12)) / Math.max(0.02, v)) : speedFor(v)
          a.lfo.frequency.value = sp
          b.lfo.frequency.value = sp
          a.fadeLfo.frequency.value = Math.max(0.15, sp / 2)
          b.fadeLfo.frequency.value = Math.max(0.15, sp / 2)
        }
      }
      break
    }
    case 'autotune': {
      setMix(shell, p('mix', 0.8))
      // Real-time pitch tracking + hard tuning: analyser -> autocorrelation ->
      // granular shifter ratio, smoothed by the retune amount.
      const shifter = createEffect(ctx, 'pitchshift', { semitones: 0, window: 0.06, mix: 1 })
      shell.input.connect(shifter.input)
      shifter.output.connect(shell.wet)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      shell.input.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      let current = 0
      let timer = 0
      const rate = ctx.sampleRate
      const detect = (): number => {
        analyser.getFloatTimeDomainData(buf)
        let rms = 0
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i]
        rms = Math.sqrt(rms / buf.length)
        if (rms < 0.006) return 0
        let bestLag = -1
        let bestCorr = 0
        const minLag = Math.floor(rate / 1000)
        const maxLag = Math.floor(rate / 60)
        for (let lag = minLag; lag < maxLag; lag++) {
          let corr = 0
          for (let i = 0; i < buf.length - lag; i += 2) corr += buf[i] * buf[i + lag]
          if (corr > bestCorr) {
            bestCorr = corr
            bestLag = lag
          }
        }
        if (bestLag < 0) return 0
        const f = rate / bestLag
        return f > 45 && f < 1200 ? f : 0
      }
      const scaleName = Object.keys(SCALES)[Math.max(0, Math.min(Object.keys(SCALES).length - 1, Math.round(p('scale', 0))))]
      const scale = SCALES[scaleName] || SCALES.Major
      const root = Math.round(p('root', 0))
      timer = window.setInterval(() => {
        const f = detect()
        if (!f) return
        const note = 69 + 12 * Math.log2(f / 440)
        const nearest = Math.round(note - root) % 12
        let target = 0
        let bestDist = 99
        for (const s of scale) {
          for (const oct of [-12, 0, 12]) {
            const d = Math.abs(((s + oct - nearest + 24) % 12) - 12)
            if (d < bestDist) {
              bestDist = d
              target = s + oct
            }
          }
        }
        const diff = ((target - nearest + 24) % 12) - 6
        const wanted = diff * Math.max(0, Math.min(1, p('strength', 0.85)))
        const smooth = 0.15 + (1 - p('speed', 0.8)) * 0.75
        current = current + (wanted - current) * smooth
        shifter.set('semitones', current)
      }, 45)
      cleanup.push(() => window.clearInterval(timer))
      setter = (k, v) => {
        if (k === 'mix') setMix(shell, v)
      }
      break
    }
    case 'utility': {
      setMix(shell, p('mix', 1))
      const g = gainNode(ctx, dbToGain(p('gain', 0)))
      const split = ctx.createChannelSplitter(2)
      const merger = ctx.createChannelMerger(2)
      const l2m = gainNode(ctx, 0.5)
      const r2m = gainNode(ctx, 0.5)
      const l2s = gainNode(ctx, 0.5)
      const r2s = gainNode(ctx, -0.5)
      const outL = gainNode(ctx, 1)
      const outR = gainNode(ctx, 1)
      shell.input.connect(g)
      g.connect(split)
      split.connect(l2m, 0)
      split.connect(r2m, 1)
      split.connect(l2s, 0)
      split.connect(r2s, 1)
      // mid + side * width -> left, mid - side * width -> right
      const midGain = gainNode(ctx, 1)
      l2m.connect(midGain)
      r2m.connect(midGain)
      midGain.connect(outL)
      midGain.connect(outR)
      const sideGain = gainNode(ctx, p('mono') === 1 ? 0 : p('width', 1))
      l2s.connect(sideGain)
      r2s.connect(sideGain)
      sideGain.connect(outL)
      sideGain.connect(outR)
      outL.connect(merger, 0, 0)
      outR.connect(merger, 0, 1)
      merger.connect(shell.wet)
      setter = (k, v) => {
        if (k === 'gain') g.gain.value = dbToGain(v)
        else if (k === 'width') sideGain.gain.value = p('mono') === 1 ? 0 : v
        else if (k === 'mono') sideGain.gain.value = v === 1 ? 0 : p('width', 1)
        else if (k === 'mix') setMix(shell, v)
      }
      break
    }
    default:
      setMix(shell, 1)
      shell.input.connect(shell.wet)
      break
  }

  setMix(shell, type === 'eq3' ? 1 : params.mix ?? 1)

  return {
    type,
    input: shell.input,
    output: shell.output,
    set: (k, v) => setter(k, v),
    dispose: () => {
      for (const fn of cleanup) fn()
      try {
        shell.input.disconnect()
        shell.output.disconnect()
      } catch {
        /* noop */
      }
    },
  }
}
