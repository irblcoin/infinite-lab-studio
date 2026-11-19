// ---------------------------------------------------------------------------
// Web MIDI input: device discovery, hot-plug, note dispatch.
// ---------------------------------------------------------------------------

export interface MidiDeviceInfo {
  id: string
  name: string
  manufacturer: string
}

export interface MidiNoteEvent {
  pitch: number
  vel: number
  on: boolean
  channel: number
  deviceId: string
}

type NoteListener = (e: MidiNoteEvent) => void
type ChangeListener = () => void

class MidiManager {
  private access: MIDIAccess | null = null
  private noteListeners = new Set<NoteListener>()
  private changeListeners = new Set<ChangeListener>()
  private pending = new Set<string>()
  private lastError: string | null = null
  enabled = false
  connecting = false
  devices: MidiDeviceInfo[] = []

  get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
  }

  get error(): string | null {
    return this.lastError
  }

  async enable(): Promise<boolean> {
    if (!this.supported) {
      this.lastError = 'This browser has no Web MIDI support. Chrome and Edge support MIDI keyboards.'
      this.emitChange()
      return false
    }
    if (this.access) return true
    this.connecting = true
    this.emitChange()
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.access.onstatechange = () => {
        this.refresh()
        this.bind()
      }
      this.refresh()
      this.bind()
      this.enabled = true
      this.lastError = null
      return true
    } catch (err) {
      this.lastError =
        err instanceof DOMException && err.name === 'SecurityError'
          ? 'MIDI access was blocked. Allow MIDI for this site, then press Connect again.'
          : 'Could not open MIDI. Close other apps that lock the device and try again.'
      return false
    } finally {
      this.connecting = false
      this.emitChange()
    }
  }

  private refresh(): void {
    if (!this.access) return
    const list: MidiDeviceInfo[] = []
    this.access.inputs.forEach((input) => {
      list.push({ id: input.id, name: input.name || 'MIDI input', manufacturer: input.manufacturer || '' })
    })
    this.devices = list.sort((a, b) => a.name.localeCompare(b.name))
    this.emitChange()
  }

  private bind(): void {
    if (!this.access) return
    this.access.inputs.forEach((input) => {
      if (this.pending.has(input.id)) return
      this.pending.add(input.id)
      input.onmidimessage = (ev) => this.handle(ev, input.id)
    })
  }

  private handle(ev: MIDIMessageEvent, deviceId: string): void {
    const data = ev.data
    if (!data || data.length < 2) return
    const status = data[0] & 0xf0
    const channel = (data[0] & 0x0f) + 1
    if (status === 0x90 && data[2] > 0) this.fire({ pitch: data[1], vel: data[2] / 127, on: true, channel, deviceId })
    else if (status === 0x80 || (status === 0x90 && data[2] === 0))
      this.fire({ pitch: data[1], vel: 0, on: false, channel, deviceId })
  }

  private fire(e: MidiNoteEvent): void {
    for (const l of this.noteListeners) {
      try {
        l(e)
      } catch (err) {
        console.warn('[ILS] MIDI listener failed', err)
      }
    }
  }

  onNote(cb: NoteListener): () => void {
    this.noteListeners.add(cb)
    return () => this.noteListeners.delete(cb)
  }

  subscribe(cb: ChangeListener): () => void {
    this.changeListeners.add(cb)
    return () => this.changeListeners.delete(cb)
  }

  private emitChange(): void {
    for (const cb of this.changeListeners) cb()
  }

  /** Fire a virtual note (on-screen pads) through the same path as hardware. */
  simulate(pitch: number, vel = 0.9, on = true): void {
    this.fire({ pitch, vel, on, channel: 1, deviceId: 'virtual' })
  }
}

export const midi = new MidiManager()
