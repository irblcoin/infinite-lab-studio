// ---------------------------------------------------------------------------
// Web Audio Modules (WAM) host
//
// Loads a plugin by URL and routes its audio node into the studio. Supports the
// three shapes WAM packages ship in:
//   1. a descriptor object with createInstance(groupId, audioContext, state)
//   2. a default-exported class constructed with (audioContext, options)
//   3. an object exposing a ready-made `audioNode`
// ---------------------------------------------------------------------------

export interface WamHosted {
  url: string
  name: string
  node: AudioNode
  output: GainNode
  disconnect: () => void
}

type WamModule = {
  default?: unknown
  createInstance?: (groupId: string, ctx: BaseAudioContext, initialState?: unknown) => Promise<unknown>
  audioNode?: AudioNode
  name?: string
  descriptorIdentifier?: string
}

function findNode(instance: unknown): AudioNode | null {
  if (!instance || typeof instance !== 'object') return null
  const obj = instance as Record<string, unknown>
  const candidates = ['audioNode', 'node', 'output', 'audioOutput']
  for (const key of candidates) {
    const v = obj[key]
    if (v && typeof (v as AudioNode).connect === 'function') return v as AudioNode
  }
  if (typeof (instance as AudioNode).connect === 'function') return instance as AudioNode
  return null
}

export async function hostWamPlugin(url: string, ctx: BaseAudioContext, dest: AudioNode): Promise<WamHosted> {
  const mod = (await import(/* @vite-ignore */ url)) as WamModule
  const groupId = `ils-${Math.random().toString(36).slice(2, 8)}`
  const name =
    (typeof mod.name === 'string' && mod.name) ||
    (mod.descriptorIdentifier ? String(mod.descriptorIdentifier) : '') ||
    url.split('/').filter(Boolean).pop()?.replace(/\.js$/, '') ||
    'WAM plugin'

  let instance: unknown = null
  const descriptor = (mod.default ?? mod) as WamModule & { new?: unknown }
  try {
    if (descriptor && typeof (descriptor as WamModule).createInstance === 'function') {
      instance = await (descriptor as WamModule).createInstance!(groupId, ctx, {})
    } else if (typeof descriptor === 'function') {
      instance = new (descriptor as unknown as new (c: BaseAudioContext, o?: unknown) => unknown)(ctx, {})
    } else if (mod.createInstance) {
      instance = await mod.createInstance(groupId, ctx, {})
    } else if (descriptor && typeof descriptor === 'object') {
      instance = descriptor
    }
  } catch (err) {
    throw new Error(`The plugin loaded but could not start: ${(err as Error).message}`)
  }

  const node = findNode(instance)
  if (!node) throw new Error('This module does not expose a Web Audio node, so it is not a WAM audio plugin.')

  const output = ctx.createGain()
  output.gain.value = 0.8
  node.connect(output)
  output.connect(dest)

  return {
    url,
    name,
    node,
    output,
    disconnect: () => {
      try {
        node.disconnect()
      } catch {
        /* already gone */
      }
      try {
        output.disconnect()
      } catch {
        /* already gone */
      }
      const destroy = (instance as { destroy?: () => void } | null)?.destroy
      if (typeof destroy === 'function') destroy.call(instance)
    },
  }
}
