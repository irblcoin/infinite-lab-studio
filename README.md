# ILS – Infinite Lab Studio

A product of Building Billions LLC.

A voice-activated browser DAW: sequencer, piano roll, mixer, racks, recording, real sampled
instruments, stem separation, mastering, offline sound packs, and a voice assistant that runs the
same commands you can type. No account, no API keys, no server.

## Source

The full source tree and the homepage photo assets ship as `ils-source.tar.gz` on the
[v1.0.0 release](../../releases/tag/v1.0.0). The **Import source** workflow unpacks it into this
branch.

## Sample packs (not in git)

The ~197 MB of openly licensed sample packs are downloaded on demand, not committed. Fetch them
once after cloning:

```
python3 scripts/fetch-packs.py        # all packs, resumable
python3 scripts/fetch-packs.py acoustic drums   # or just some
```

This also writes `public/packs/index.json`, the pack catalogue.

## Run

```
npm ci
python3 scripts/fetch-packs.py
npm run dev        # http://localhost:3000
npm run build      # tsc -b && vite build
```

## Homepage photo

```
python3 scripts/build-home-photo.py path/to/studio.jpg
```

Straightens the photo, crops any grey corners, writes WebP + JPG srcsets and a blurred placeholder,
and regenerates `src/ui/homePhoto.ts`.

---

© 2026 Building Billions LLC. All rights reserved.
