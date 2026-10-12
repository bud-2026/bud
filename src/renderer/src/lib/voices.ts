// Built-in Pocket-TTS voices available for the bundled English model. The names
// must match the predefined voice catalog shipped by the `pocket_tts` package so
// the backend can resolve them from its HuggingFace voice repository.
//
// `jane` and `alba` are pre-cached by the backend, so previewing them starts
// instantly; the remaining voices are downloaded on first use.

export interface PocketTtsVoiceGroup {
  /** Short heading shown above the group in the settings panel. */
  label: string
  voices: readonly string[]
}

export const POCKET_TTS_VOICE_GROUPS: readonly PocketTtsVoiceGroup[] = [
  {
    label: 'Default voices',
    voices: ['jane', 'alba']
  },
  {
    label: 'More voices',
    voices: [
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
      'javert',
      'jean',
      'marius',
      'mary',
      'michael',
      'paul',
      'peter_yearsley',
      'stuart_bell',
      'vera'
    ]
  }
]

/** Voice the backend falls back to when the user has not chosen one. */
export const DEFAULT_TTS_VOICE = 'jane'

/** Turns an internal voice id (e.g. "bill_boerst") into a readable label. */
export function formatVoiceName(voice: string): string {
  return voice
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
