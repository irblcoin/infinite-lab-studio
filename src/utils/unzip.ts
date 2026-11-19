// ---------------------------------------------------------------------------
// Reads store-only ZIP archives written by utils/zip.ts. Used for the
// "import zipped project" path so no dependency is needed.
// ---------------------------------------------------------------------------

export interface Unzipped {
  name: string
  data: Uint8Array
}

export async function readZip(blob: Blob): Promise<Unzipped[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const dv = new DataView(bytes.buffer)
  // Find the end-of-central-directory record.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip file')
  const count = dv.getUint16(eocd + 10, true)
  let ptr = dv.getUint32(eocd + 16, true)
  const out: Unzipped[] = []
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break
    const method = dv.getUint16(ptr + 10, true)
    const size = dv.getUint32(ptr + 20, true)
    const nameLen = dv.getUint16(ptr + 28, true)
    const extraLen = dv.getUint16(ptr + 30, true)
    const commentLen = dv.getUint16(ptr + 32, true)
    const localOffset = dv.getUint32(ptr + 42, true)
    const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen))
    if (method === 0) {
      const localNameLen = dv.getUint16(localOffset + 26, true)
      const localExtra = dv.getUint16(localOffset + 28, true)
      const start = localOffset + 30 + localNameLen + localExtra
      out.push({ name, data: bytes.slice(start, start + size) })
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}
