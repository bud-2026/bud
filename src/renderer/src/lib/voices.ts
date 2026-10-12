// Built-in Pocket-TTS voices available for the bundled English model. The names
// must match the predefined voice catalog shipped by the `pocket_tts` package so
// the backend can resolve them from its HuggingFace voice repository.
export const POCKET_TTS_VOICES = [
  'alba',
  'anna',
  'azelma',
  'bill_boerst',
  'caro_davy',
  'charles',
  'cosette',
  'eponine',
  'eve',
  'fantine',
  'george',
  'jane',
  'javert',
  'jean',
  'marius',
  'mary',
  'michael',
  'paul',
  'peter_yearsley',
  'stuart_bell',
  'vera'
] as const

export type PocketTtsVoice = (typeof POCKET_TTS_VOICES)[number]

/** Voice the backend falls back to when the user has not chosen one. */
export const DEFAULT_TTS_VOICE: PocketTtsVoice = 'jane'

/** Turns an internal voice id (e.g. "bill_boerst") into a readable label. */
export function formatVoiceName(voice: string): string {
  return voice
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
