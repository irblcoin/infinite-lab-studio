/* Minimal Web Speech API wrapper with graceful degradation. */

interface SpeechAlternative {
  transcript: string
  confidence: number
}
interface SpeechResult {
  isFinal: boolean
  length: number
  [index: number]: SpeechAlternative
}
interface SpeechResultList {
  length: number
  [index: number]: SpeechResult
}
interface SpeechEvent extends Event {
  resultIndex: number
  results: SpeechResultList
}
interface SpeechErrorEvent extends Event {
  error: string
  message?: string
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: SpeechErrorEvent) => void) | null
  onstart: (() => void) | null
}
type RecognitionCtor = new () => Recognition

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export const speechSupported = (): boolean => !!getCtor()

export interface VoiceHandlers {
  onTranscript: (text: string, final: boolean) => void
  onListeningChange: (listening: boolean) => void
  onError: (message: string) => void
}

export class VoiceController {
  private rec: Recognition | null = null
  private wantListening = false
  private handlers: VoiceHandlers | null = null
  wakeWord = false

  get supported(): boolean {
    return speechSupported()
  }

  get listening(): boolean {
    return this.wantListening
  }

  attach(handlers: VoiceHandlers): void {
    this.handlers = handlers
  }

  start(): boolean {
    const Ctor = getCtor()
    if (!Ctor) {
      this.handlers?.onError('Voice recognition is not available in this browser. Type commands instead — the same parser handles them.')
      return false
    }
    if (this.wantListening) return true
    this.wantListening = true
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onstart = () => this.handlers?.onListeningChange(true)
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0]?.transcript ?? ''
        if (!text) continue
        this.handlers?.onTranscript(text.trim(), result.isFinal)
      }
    }
    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      const message =
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access for voice control was blocked. Allow the mic in your browser, or use the typed command bar.'
          : event.error === 'network'
            ? 'Speech recognition needs a network connection in this browser. Typed commands work offline.'
            : `Voice error: ${event.error}. You can type commands instead.`
      this.handlers?.onError(message)
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.wantListening = false
        this.handlers?.onListeningChange(false)
      }
    }
    rec.onend = () => {
      if (this.wantListening) {
        window.setTimeout(() => {
          if (!this.wantListening) return
          try {
            rec.start()
          } catch {
            try {
              this.rec = null
              this.start()
            } catch {
              this.wantListening = false
              this.handlers?.onListeningChange(false)
            }
          }
        }, 240)
      } else {
        this.handlers?.onListeningChange(false)
      }
    }
    try {
      rec.start()
    } catch {
      this.wantListening = false
      return false
    }
    this.rec = rec
    return true
  }

  stop(): void {
    this.wantListening = false
    try {
      this.rec?.stop()
    } catch {
      /* ignore */
    }
    this.rec = null
    this.handlers?.onListeningChange(false)
  }

  toggle(): boolean {
    if (this.wantListening) {
      this.stop()
      return false
    }
    return this.start()
  }

  /** Removes the wake word and reports whether the phrase was addressed to us. */
  gateWakeWord(text: string): { text: string; addressed: boolean } {
    const lower = text.toLowerCase()
    const wake = /^(hey|hi|ok|okay)?\s*(ils|i\.l\.s\.?|ills|else)\b/.test(lower)
    if (!this.wakeWord) return { text, addressed: true }
    if (wake) {
      return { text: text.replace(/^(hey|hi|ok|okay)?\s*(ils|i\.l\.s\.?|ills|else)[,\s]*/i, ''), addressed: true }
    }
    return { text, addressed: false }
  }
}

export const voice = new VoiceController()

/** Speak a short confirmation when the API is available. */
export function speak(text: string): void {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    u.pitch = 0.95
    u.volume = 0.5
    synth.cancel()
    synth.speak(u)
  } catch {
    /* ignore */
  }
}
