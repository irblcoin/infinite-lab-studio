// Convert downloaded WAV samples to MP3 and refresh the pack catalogue sizes.
// Used after scripts/fetch-sso.py and scripts/fetch-strings.py.
//
//   node scripts/encode-pack-mp3.mjs sso vsco2/strings
//
// Every .wav under the given pack folders is replaced by an .mp3 (the WAV is
// deleted), then the byte counts in public/packs/index.json are re-stat-ed.
import { readFileSync, writeFileSync, statSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import lamejs from '@breezystack/lamejs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packsDir = join(root, 'public', 'packs')
const folders = process.argv.slice(2)
if (!folders.length) {
  console.error('usage: node scripts/encode-pack-mp3.mjs <pack/folder> [...]')
  process.exit(1)
}

function readWav(path) {
  const buf = readFileSync(path)
  let offset = 12
  let fmt = null
  let data = null
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(offset + 10),
        rate: buf.readUInt32LE(offset + 12),
        bits: buf.readUInt16LE(offset + 22),
      }
    }
    if (id === 'data') {
      data = buf.subarray(offset + 8, offset + 8 + size)
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('bad wav ' + path)
  const { channels, bits, rate } = fmt
  const bytes = bits / 8
  const frames = Math.floor(data.length / (channels * bytes))
  const left = new Int16Array(frames)
  const right = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    const p = i * channels * bytes
    if (bits === 24) {
      left[i] = data.readIntLE(p, 3) >> 8
      right[i] = channels > 1 ? data.readIntLE(p + 3, 3) >> 8 : left[i]
    } else {
      left[i] = data.readInt16LE(p)
      right[i] = channels > 1 ? data.readInt16LE(p + 2) : left[i]
    }
  }
  return { left, right, sampleRate: rate, frames }
}

function encodeMp3(wavPath, outPath) {
  const { left, right, sampleRate, frames } = readWav(wavPath)
  const enc = new lamejs.Mp3Encoder(2, sampleRate, 192)
  const parts = []
  for (let i = 0; i < frames; i += 1152) {
    const buf = enc.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152))
    if (buf.length) parts.push(Buffer.from(buf))
  }
  const end = enc.flush()
  if (end.length) parts.push(Buffer.from(end))
  writeFileSync(outPath, Buffer.concat(parts))
}

let count = 0
let bytes = 0
let failed = 0
for (const folder of folders) {
  const dir = join(packsDir, folder)
  if (!existsSync(dir)) {
    console.error(`  !! missing folder ${folder}`)
    failed++
    continue
  }
  for (const file of readdirSync(dir, { recursive: true })) {
    if (extname(String(file)).toLowerCase() !== '.wav') continue
    const wavPath = join(dir, String(file))
    const outPath = wavPath.replace(/\.wav$/i, '.mp3')
    try {
      encodeMp3(wavPath, outPath)
      unlinkSync(wavPath)
      bytes += statSync(outPath).size
      count++
    } catch (err) {
      console.error(`  !! ${folder}/${file}: ${err.message}`)
      failed++
    }
  }
}
console.log(`encoded ${count} samples, ${(bytes / 1e6).toFixed(1)} MB${failed ? `, ${failed} failed` : ''}`)

const indexPath = join(packsDir, 'index.json')
const index = JSON.parse(readFileSync(indexPath, 'utf8'))
for (const pack of index.packs) {
  let sum = 0
  for (const f of pack.files) {
    const abs = join(packsDir, pack.id, f.path)
    if (!existsSync(abs)) continue
    f.bytes = statSync(abs).size
    sum += f.bytes
  }
  pack.bytes = sum
}
writeFileSync(indexPath, JSON.stringify(index, null, 1))
console.log(`catalogue refreshed for ${index.packs.length} packs`)
