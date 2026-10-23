export type ReadinessLevel = 'ready' | 'starting' | 'error' | 'off'

export interface Readiness {
  /** Aggregate "is Bud usable" level. */
  level: ReadinessLevel
  /** True only when the aggregate level is `ready`. */
  ready: boolean
  vision: ReadinessLevel
  speech: ReadinessLevel
  tts: ReadinessLevel
}

function visionLevel(vlStatus: VlStatusSnapshot | null): ReadinessLevel {
  if (!vlStatus) return 'starting'
  const phases = [
    vlStatus.runtime.phase,
    vlStatus.model.phase,
    vlStatus.mmproj.phase,
    vlStatus.server.phase
  ]
  if (phases.includes('error')) return 'error'
  // The inference server only reports `ready` once the runtime, model and
  // projector are loaded, so it is the strongest "vision is usable" signal.
  if (vlStatus.server.phase === 'ready') return 'ready'
  return 'starting'
}

function speechLevel(sttStatus: SttStatusSnapshot | null): ReadinessLevel {
  if (!sttStatus) return 'starting'
  const phases = [sttStatus.wakeWord.phase, sttStatus.transcription.phase]
  if (phases.includes('error')) return 'error'
  if (phases.every((phase) => phase === 'ready')) return 'ready'
  if (phases.every((phase) => phase === 'off')) return 'off'
  return 'starting'
}

function ttsLevel(ttsStatus: BackendComponentStatus | null): ReadinessLevel {
  if (!ttsStatus) return 'starting'
  if (ttsStatus.phase === 'ready') return 'ready'
  if (ttsStatus.phase === 'error') return 'error'
  if (ttsStatus.phase === 'off') return 'off'
  return 'starting'
}

/**
 * Aggregates the per-component status into a single "is Bud usable" signal.
 * Voice is only required while it is enabled: when the user has voice off we
 * deliberately do not let a stopped speech/TTS backend block readiness.
 */
export function computeReadiness(
  vlStatus: VlStatusSnapshot | null,
  sttStatus: SttStatusSnapshot | null,
  ttsStatus: BackendComponentStatus | null,
  voiceEnabled: boolean
): Readiness {
  const vision = visionLevel(vlStatus)
  const speech = speechLevel(sttStatus)
  const tts = ttsLevel(ttsStatus)
  const required = voiceEnabled ? [vision, speech, tts] : [vision, tts]

  let level: ReadinessLevel
  if (required.some((entry) => entry === 'error')) {
    level = 'error'
  } else if (required.every((entry) => entry === 'ready')) {
    level = 'ready'
  } else {
    level = 'starting'
  }

  return { level, ready: level === 'ready', vision, speech, tts }
}

export type ReadinessTone = 'ready' | 'pending' | 'error'

export interface ReadinessSummary {
  label: string
  tone: ReadinessTone
}

/** Short chip label + tone for a single readiness level. */
export function describeReadiness(level: ReadinessLevel): ReadinessSummary {
  switch (level) {
    case 'ready':
      return { label: 'Ready', tone: 'ready' }
    case 'error':
      return { label: 'Unavailable', tone: 'error' }
    case 'off':
      return { label: 'Off', tone: 'pending' }
    case 'starting':
      return { label: 'Starting…', tone: 'pending' }
  }
}

/** Headline + description for the aggregate readiness banner. */
export function describeGlobalReadiness(readiness: Readiness): {
  title: string
  description: string
} {
  switch (readiness.level) {
    case 'ready':
      return {
        title: 'Bud is ready',
        description: 'All required components are running. Voice and screen analysis are available.'
      }
    case 'error':
      return {
        title: 'Bud is not ready',
        description: 'One or more components failed to start. Review the components below.'
      }
    default:
      return {
        title: 'Getting Bud ready…',
        description: 'Components are still starting. Features unlock automatically when ready.'
      }
  }
}
