# ILS — Infinite Lab Studio

A complete music studio in the browser: real sampled instruments, a sequencer, mixer, racks,
recording, warping, comping, metering and full voice **and** typed command control.
No account, no API keys, no server — everything runs locally and the sound packs are
openly licensed recordings served as static files.

```bash
npm ci
npm run dev      # http://localhost:3000
npm run build    # typecheck + production build into dist/
npm run preview  # serve the build on http://localhost:4173
```

## What is in the box

**Instruments & sounds** (all real recordings, installed per pack from the *Packs* tab):

| Pack | Content | Licence |
| --- | --- | --- |
| Salamander Grand Piano | Yamaha C5, 29 samples | CC BY 3.0 |
| FluidR3 General MIDI | 27 GM instruments, 2,219 samples | CC BY 3.0 |
| VSCO 2 Community Edition | sustained violin, viola and cello sections (26 sampled keys, 24–74), brass + woodwinds | CC0 |
| Sonatina Symphonic Orchestra | choir (female/male), flutes, clarinets, concert harp | CC Sampling Plus 1.0 |
| Drum Machines | TR-808, TR-909, LinnDrum LM-2 | CC0 / public domain |
| Acoustic Kit | layered + round-robin kick, snare, clap, hats, ride, perc | CC0 |
| Hip Hop & Club Kits | boom bap, trap, R&B, EDM kits + playable 808 sub bass | CC0 |
| Guitars & Bass | acoustic, nylon, electric, fingered bass multisamples | CC BY 3.0 |
| Pianos & Keys | upright piano, celesta, drawbar organ, harmonium, harp | CC BY 3.0 |
| Sampled Synths | leads, pads, choir and brass sampled from a synth set | CC BY 3.0 |
| FX & Textures | risers, impacts, sweeps, sci-fi, crowd, vinyl noise | CC BY 3.0 / CC0 |
| Real Loops | 56 loops (8 genres) tagged with BPM + key, warped to the project tempo | CC0 / CC BY 3.0 |

* Drag-and-drop import of WAV/FLAC/MP3/OGG, **SFZ** and **SF2** — stored in IndexedDB.
* The sampler does filename key-mapping, velocity layers, round-robin, sustain loops,
  release tails, per-zone tuning and peak normalisation.
* Synths (code-generated) live only in the **Synth** category; everything else is sampled.

**Production tools**

* Multisample/SFZ/SF2 engine with lazy decoding and pack-aware sample cache.
* **Warping**: transient detection, BPM detection, warp markers, WSOLA time-stretch with
  Beats / Complex / Tones / Texture modes, pitch shift, one-click “warp to project tempo”.
* **Sidechain** ducking with any track as the key source, plus pumping/soft/hard presets.
* **Tempo automation** and **time-signature changes** along the timeline (real tempo map).
* **Clip envelopes**, **groove templates**, **consolidate**, **freeze** and **flatten**.
* **Audio → MIDI** for melody, harmony and drums.
* **Comping**: takes per clip, auto-comp, swipe cells per bar.
* **Vocal chains**: Clean, Rap, Auto-Tune, Radio, Lo-Fi + one-click **Vocal Booth**.
* **Return presets**: plate, hall, slap delay, tape echo. **Master presets** at −14 LUFS
  (streaming) and −9 LUFS (club) with glue compressor, EQ and limiter.
* **Metering**: real-time spectrum analyser, phase scope (goniometer) and LUFS meter.
* 32-bit float internal path, convolution reverb with IR loading, 16/24/32-bit WAV export
  with TPDF dither, MP3, stems, MIDI, project files, mix snapshots, undo/redo.
* Microphone recording with device selection and latency compensation, Web MIDI with hot-plug,
  voice commands (Web Speech) and an identical typed command bar.

## Layout

```
src/
  audio/    engine, warp, tempo map, analysis (audio→MIDI/LUFS), patch/sampler,
            sfz, sf2, effects, drums, instruments, render, midi, wam
  data/     pack store, pack catalogue types, device presets, loops catalogue
  state/    store, actions, features (warp/sidechain/comp/master), db, recording
  ui/       transport, sequencer, mixer, racks, editor, library, packs, clip tools,
            meters, tour, modals
  voice/    parser + executor (every feature has a spoken command)
public/
  packs/    the sound packs + index.json catalogue (static, immutable)
  sw.js     service worker (offline shell + packs)
  _headers  Cloudflare Pages caching + MIME headers
  _redirects SPA fallback
scripts/    pack fetcher, loop renderer/encoder, GitHub directory lister
```

## Rebuilding the sample content

```bash
python3 scripts/fetch-packs.py            # or: python3 scripts/fetch-packs.py guitars keys2
python3 scripts/fetch-sso.py              # Sonatina orchestra (GitHub raw)
python3 scripts/fetch-strings.py          # VSCO string sections
node scripts/encode-pack-mp3.mjs sso vsco2/strings   # WAV -> MP3 + catalogue sizes
python3 scripts/make-loops.py             # renders 56 loops from real one-shots
node scripts/encode-loops.mjs             # MP3 encode + src/data/loops.ts + index.json
```

`fetch-packs.py` is resumable and verifies audio magic bytes, so an interrupted download or a
server that answers with HTML never ends up stored as a sample.

## Deploy

Everything is static; the build output is `dist/` (≈180 MB because of the packs, roughly
2,800 files — inside Cloudflare Pages' 25 MiB-per-file / 20,000-file limits).

**Cloudflare Pages**

```bash
npm ci && npm run build
npx wrangler pages deploy dist --project-name ils-studio
```

or connect the repo with build command `npm run build` and output directory `dist`.
`public/_headers` sets immutable caching for `/packs/*` and `/assets/*`, correct audio MIME
handling, `no-cache` for the service worker and the microphone/MIDI permissions policy.
`public/_redirects` serves the SPA shell for unknown paths.

**Vercel**

```bash
npm ci && npm run build
npx vercel --prod
```

`vercel.json` sets the build command, output directory, SPA rewrites, cache headers and
permissions policy.

**PWA / offline** — `public/manifest.webmanifest` + `public/sw.js` make the app installable.
The shell is cached on install, and pack/loop files are cached the first time they are used, so
an installed app works offline once its packs have been played (installed packs are also kept in
IndexedDB).

## Tests and verification

```bash
npm run typecheck   # tsc -b --force
npm run build       # typecheck + vite build
```

The build is expected to be warning-clean apart from Vite's dynamic-vs-static import notes.

Verified in a real browser: pack installs (44/44 acoustic files), loop load/decode, BPM
detection (89.6 for a 90 BPM loop), warp length (5.38 s → 4.04 s at 120 BPM, ratio 1.333),
sidechain depth (0.9), tempo-map maths (16 beats = 7.43 s across 120→140 BPM), audio→MIDI
(10 notes), LUFS metering, master/vocal/return presets, and command parsing.

## Licences

All sample content is CC0, CC BY 3.0 or public domain; sources and authors are listed on the
in-app **Credits** page (Settings → Credits) and in `public/packs/index.json`.
Imported user audio stays in the browser and is never uploaded.

## Homepage photo

The homepage is built around a photograph of the room. Drop a new photo in and rebuild every
derivative (straightened, grey corners cropped, WebP + JPG srcset, blurred placeholder, and the
coordinates for the wall-monitor overlay):

```
python3 scripts/build-home-photo.py path/to/studio.jpg
```

Options: `--rotate DEG` overrides the detected tilt, `--screen l,t,w,h` moves the live mini-mixer
onto the monitor screen, `--no-enhance` skips the exposure lift. If the photo cannot load, the
hand-drawn control-room scene is used instead.
