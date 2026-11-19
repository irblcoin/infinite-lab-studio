// ---------------------------------------------------------------------------
// Maps generated / demo track roles onto the real sampled instruments that ship
// with the app, so the demo content and the Create generator play recordings
// rather than oscillators. Falls back to synths when a pack is unavailable.
// ---------------------------------------------------------------------------

import { getPatch } from '../audio/patch'

export interface RealInstrumentChoice {
  instrumentId: string
  label: string
}

const ROLE_PATCHES: { match: RegExp; ids: string[] }[] = [
  { match: /drum|kit|perc/i, ids: ['dr_lm2', 'dr_909', 'dr_808'] },
  { match: /bass|808|sub/i, ids: ['gm_electric_bass_finger', 'gm_acoustic_bass', 'gm_electric_bass_pick'] },
  { match: /piano|keys|rhodes|chord/i, ids: ['sam_salamander', 'gm_electric_piano_1', 'gm_electric_piano_2'] },
  { match: /string|violin|viola|cello|orch/i, ids: ['vsco_string_ensemble', 'vsco_violin_ensemble', 'vsco_cello_ensemble', 'gm_string_ensemble_1'] },
  { match: /horn|brass|trumpet|trombone/i, ids: ['vsco_trumpet', 'vsco_f_horn', 'gm_trumpet'] },
  { match: /flute|clarinet|woodwind|oboe/i, ids: ['sso_flutes', 'sso_clarinets', 'vsco_clarinet', 'gm_flute'] },
  { match: /choir|vox|vocal|voice/i, ids: ['sso_chorus_female', 'sso_chorus_male', 'gm_choir_aahs', 'gm_voice_oohs'] },
  { match: /harp/i, ids: ['sso_harp'] },
  { match: /guitar|pluck|arp/i, ids: ['gm_acoustic_guitar_steel', 'gm_electric_guitar_clean', 'gm_acoustic_guitar_nylon'] },
  { match: /melody|lead|solo|hook/i, ids: ['gm_flute', 'gm_electric_piano_1', 'gm_trumpet'] },
  { match: /pad|atmos|texture/i, ids: ['gm_string_ensemble_2', 'gm_choir_aahs'] },
  { match: /organ/i, ids: ['gm_drawbar_organ', 'gm_rock_organ'] },
  { match: /marimba|vibra|bell|mallet/i, ids: ['gm_marimba', 'gm_vibraphone'] },
]

/** Pick a real instrument for a track name, if that pack is registered. */
export function realInstrumentFor(trackName: string): RealInstrumentChoice | null {
  for (const role of ROLE_PATCHES) {
    if (!role.match.test(trackName)) continue
    for (const id of role.ids) {
      const patch = getPatch(id)
      if (patch) return { instrumentId: patch.id, label: patch.name }
    }
  }
  return null
}

/** Default patch ids used by the demo project and the sampler browser. */
export const SAMPLER_DEFAULTS = {
  root: 60,
  gain: 1,
  attack: 0.002,
  release: 0.14,
  cutoff: 15000,
  pitch: 0,
  reverse: 0,
  res: 0.6,
}
