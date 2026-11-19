// ---------------------------------------------------------------------------
// Browser stem separation front-end: decodes on the main context, processes in
// a worker with progress and cancel, and reports whether the device is fast
// enough for the job.
// ---------------------------------------------------------------------------

export type StemName = 'vocals' | 'drums' | 'bass' | 'other'
export const STEM_NAMES: StemName[] = ['vocals', 'drums', 'bass', 'other']

export interface StemResult {
  name: StemName
  buffer: AudioBuffer
}

export interface SeparateOptions {
  onProgress?: (value: number, note: string) => void
  signal?: { cancelled: boolean }
}

export interface SeparateOutcome {
  ok: boolean
  stems: StemResult[]
  ms: number
  /** Real-time factor: 1 means the job took as long as the audio plays. */
  realtimeFactor: number
  slow: boolean
  message?: string
  cancelled?: boolean
}

let workerRef: Worker | null = null

function makeWorker(): Worker {
  return new Worker(new URL('../workers/stems.worker.ts', import.meta.url), { type: 'module' })
}

export async function separateStems(buffer: AudioBuffer, opts: SeparateOptions = {}): Promise<SeparateOutcome> {
  const started = performance.now()
  const ctx = new OfflineAudioContext(1, 1, buffer.sampleRate)
  void ctx
  const channels = Math.min(2, buffer.numberOfChannels)
  const left = buffer.getChannelData(0).slice()
  const right = channels > 1 ? buffer.getChannelData(1).slice() : left.slice()
  const worker = makeWorker()
  workerRef = worker
  const duration = buffer.duration
  const slowBudget = duration * 1000 * 1.2
  let cancelled = false

  const watchdog = window.setTimeout(() => {
    opts.onProgress?.(-1, 'This device is taking a long time — separation will finish or you can cancel.')
  }, Math.max(12000, slowBudget + 8000))

  const result = await new Promise<SeparateOutcome>((resolve) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: 'progress'; value: number; note: string }
        | { type: 'done'; sampleRate: number; stems: Record<StemName, Float32Array> }
      if (msg.type === 'progress') {
        opts.onProgress?.(msg.value, msg.note)
        return
      }
      if (opts.signal?.cancelled) {
        resolve({ ok: false, stems: [], ms: 0, realtimeFactor: 0, slow: false, cancelled: true })
        return
      }
      const outCtx =
        typeof OfflineAudioContext !== 'undefined'
          ? new OfflineAudioContext(2, Math.max(1, Math.round(duration * msg.sampleRate)), msg.sampleRate)
          : null
      if (!outCtx) {
        resolve({ ok: false, stems: [], ms: 0, realtimeFactor: 0, slow: false, message: 'Audio rendering is unavailable.' })
        return
      }
      const stems: StemResult[] = STEM_NAMES.map((name) => {
        const mono = msg.stems[name]
        const buf = outCtx.createBuffer(2, mono.length, msg.sampleRate)
        buf.copyToChannel(new Float32Array(mono), 0)
        buf.copyToChannel(new Float32Array(mono), 1)
        return { name, buffer: buf }
      })
      const ms = performance.now() - started
      const realtimeFactor = ms / Math.max(1, duration * 1000)
      resolve({
        ok: true,
        stems,
        ms,
        realtimeFactor,
        slow: realtimeFactor > 1.5,
        message:
          realtimeFactor > 1.5
            ? `This device separated the audio at ${realtimeFactor.toFixed(1)}× real time. A shorter range or a faster machine will feel quicker.`
            : undefined,
      })
    }
    worker.onerror = (err) => {
      resolve({
        ok: false,
        stems: [],
        ms: performance.now() - started,
        realtimeFactor: 0,
        slow: false,
        message: err.message || 'The separation worker failed.',
      })
    }
    if (opts.signal?.cancelled) cancelled = true
    worker.postMessage({ type: 'separate', left, right, sampleRate: buffer.sampleRate }, [left.buffer, right.buffer])
    // Cancel polling is handled by terminate(); this interval keeps the promise
    // honest if the worker never posts.
    const poll = window.setInterval(() => {
      if (opts.signal?.cancelled) cancelled = true
      if (cancelled) {
        worker.terminate()
        window.clearInterval(poll)
        resolve({ ok: false, stems: [], ms: performance.now() - started, realtimeFactor: 0, slow: false, cancelled: true })
      }
    }, 250)
    const finish = resolve
    void finish
    window.setTimeout(() => window.clearInterval(poll), Math.max(60000, slowBudget + 60000))
  })
  window.clearTimeout(watchdog)
  worker.terminate()
  workerRef = null
  return result
}

export function cancelSeparation(): void {
  workerRef?.terminate()
  workerRef = null
}
