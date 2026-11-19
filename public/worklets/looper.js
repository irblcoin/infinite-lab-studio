// ILS looper worklet: a sound-on-sound capture looper.
// Records continuously into a ring buffer and plays back the last `length`
// seconds at `speed`, with feedback. Runs on the audio thread so the UI stays
// at 60 fps.
class ILSLooper extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'length', defaultValue: 2, minValue: 0.05, maxValue: 30, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.6, minValue: 0, maxValue: 0.98, automationRate: 'k-rate' },
      { name: 'speed', defaultValue: 1, minValue: 0.1, maxValue: 4, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.bufferL = new Float32Array(0)
    this.bufferR = new Float32Array(0)
    this.write = 0
    this.readPos = 0
    this.lastLength = 0
  }

  ensure(lengthSec) {
    const frames = Math.max(1, Math.min(30 * sampleRate, Math.round(lengthSec * sampleRate)))
    if (frames !== this.bufferL.length) {
      this.bufferL = new Float32Array(frames)
      this.bufferR = new Float32Array(frames)
      this.write = 0
      this.readPos = 0
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] || []
    const output = outputs[0] || []
    const lengthParam = parameters.length[0]
    const feedback = parameters.feedback[0]
    const speed = parameters.speed[0]
    const mix = parameters.mix[0]
    this.ensure(lengthParam)
    const frames = output[0] ? output[0].length : 128
    const size = this.bufferL.length
    if (!size) return true
    if (this.readPos >= size) this.readPos = 0
    for (let i = 0; i < frames; i++) {
      const inL = input[0] ? input[0][i] : 0
      const inR = input[1] ? input[1][i] : inL
      const readIdx = Math.floor(this.readPos)
      const loopL = this.bufferL[readIdx] || 0
      const loopR = this.bufferR[readIdx] || 0
      this.bufferL[this.write] = inL + loopL * feedback
      this.bufferR[this.write] = inR + loopR * feedback
      this.write = (this.write + 1) % size
      this.readPos += speed
      if (this.readPos >= size) this.readPos -= size
      if (output[0]) output[0][i] = inL * (1 - mix) + loopL * mix
      if (output[1]) output[1][i] = inR * (1 - mix) + loopR * mix
    }
    return true
  }
}

registerProcessor('ils-looper', ILSLooper)
