// ---------------------------------------------------------------------------
// Project export/import: zipped project folder with project.json, MIDI, the
// full mix and optional WAV stems.
// ---------------------------------------------------------------------------

import { getState, toast, adoptProject } from './store'
import { audioBufferToWav, downloadBlob, projectToMidi, renderProject, renderTrackBuffer } from '../audio/render'
import { buildZip, textEntry, binaryEntry, type ZipEntry } from '../utils/zip'
import { readZip } from '../utils/unzip'
import { uid, type Project } from './types'
import { loadProjectAssets } from './store'

export interface ZipOptions {
  stems?: boolean
  mix?: boolean
  midi?: boolean
  loopOnly?: boolean
  onProgress?: (note: string, value: number) => void
}

function safe(name: string): string {
  return name.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60) || 'ils'
}

export async function exportProjectZip(opts: ZipOptions = {}): Promise<void> {
  const { project } = getState()
  const name = safe(project.name)
  const entries: ZipEntry[] = []
  const report = opts.onProgress ?? (() => undefined)
  report('Writing project.json', 0.04)
  entries.push(
    textEntry(
      `${name}/project.json`,
      JSON.stringify({ kind: 'ils-project', version: 2, project, exportedAt: new Date().toISOString() }, null, 2),
    ),
  )
  entries.push(
    textEntry(
      `${name}/README.txt`,
      [
        `ILS – Infinite Lab Studio project: ${project.name}`,
        `${project.bpm} BPM · ${project.keyRoot} ${project.keyScale} · ${project.tracks.length} tracks`,
        '',
        'Import the project.json in ILS (Projects → Import) to reopen the arrangement.',
        'Audio stems and the mix are 24-bit WAV; midi/ has the MIDI parts.',
        'Made with ILS — everything runs locally, no account or API key required.',
      ].join('\n'),
    ),
  )
  if (opts.midi !== false) {
    report('Writing MIDI', 0.12)
    entries.push(await binaryEntry(`${name}/midi/${name}.mid`, projectToMidi(project)))
  }
  const range = opts.loopOnly ? { startBeat: project.loop.start, endBeat: project.loop.end } : {}
  if (opts.mix !== false) {
    report('Rendering the mix', 0.2)
    const mix = await renderProject(project, { ...range, masterLimiter: true })
    entries.push(await binaryEntry(`${name}/${name} - mix.wav`, audioBufferToWav(mix, { bitDepth: 24 })))
  }
  if (opts.stems) {
    const tracks = project.tracks.filter((t) => t.kind !== 'group' && t.clips.length > 0)
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      report(`Rendering stem ${i + 1}/${tracks.length}: ${track.name}`, 0.35 + (i / Math.max(1, tracks.length)) * 0.6)
      const buf = await renderTrackBuffer(project, track.id)
      if (buf) entries.push(await binaryEntry(`${name}/stems/${safe(track.name)}.wav`, audioBufferToWav(buf, { bitDepth: 24 })))
    }
  }
  report('Zipping', 0.97)
  const blob = buildZip(entries)
  downloadBlob(blob, `${name}.ils.zip`)
  toast(`Exported ${entries.length} files as ${name}.ils.zip`, 'ok', 4000)
}

export async function importProjectZip(file: File): Promise<void> {
  try {
    const files = await readZip(file)
    const projectFile = files.find((f) => /project\.json$/i.test(f.name))
    if (!projectFile) throw new Error('No project.json in that zip')
    const parsed = JSON.parse(new TextDecoder().decode(projectFile.data)) as { project?: Project }
    const project = parsed.project
    if (!project || !Array.isArray(project.tracks)) throw new Error('Bad project data')
    project.id = uid('proj')
    project.updatedAt = Date.now()
    await adoptProject(project)
    await loadProjectAssets(project)
    toast(`Imported “${project.name}” with ${files.length} files`, 'ok')
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not read that zip', 'err')
  }
}

export type { Project }
