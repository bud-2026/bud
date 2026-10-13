import { useEffect, useState } from 'react'
import { describeGlobalReadiness } from '../../lib/readiness'
import type { Readiness } from '../../lib/readiness'
import { DEFAULT_TTS_VOICE, formatVoiceName } from '../../lib/voices'

// Shared status shape for every bundled component (vision, speech, TTS). The
// vision server reports byte progress and a `downloaded` phase; the speech
// backends additionally use `loading` and `off`.
type ComponentPhase = VlPhase | BackendPhase

interface ComponentStatus {
  phase: ComponentPhase
  received?: number
  total?: number
  detail?: string
  message?: string
}

function formatMegabytes(bytes: number): string {
  return `${Math.floor(bytes / 1e6)} MB`
}

function describeStatus(status: ComponentStatus): string {
  switch (status.phase) {
    case 'pending':
      return 'Waiting…'
    case 'downloading': {
      if (status.total && status.received !== undefined) {
        const percent = Math.floor((status.received / status.total) * 100)
        return `Downloading ${formatMegabytes(status.received)} / ${formatMegabytes(
          status.total
        )} (${percent}%)`
      }
      return 'Downloading…'
    }
    case 'loading':
      return 'Loading…'
    case 'downloaded':
      return 'Downloaded'
    case 'starting':
      return 'Starting…'
    case 'ready':
      return 'Ready'
    case 'error':
      return 'Failed'
    case 'off':
      return 'Off'
  }
}

interface ModelStatusRowProps {
  label: string
  version: string
  status: ComponentStatus
}

function ModelStatusRow({ label, version, status }: ModelStatusRowProps): React.JSX.Element {
  const isDownloading = status.phase === 'downloading'
  const percent =
    isDownloading && status.total
      ? Math.min(100, Math.floor(((status.received ?? 0) / status.total) * 100))
      : 0

  return (
    <li className="model-status__row">
      <div className="model-status__head">
        <span className="model-status__label">{label}</span>
        <span className={`model-status__state model-status__state--${status.phase}`}>
          {describeStatus(status)}
        </span>
      </div>
      <span className="settings-hint">{version}</span>
      {isDownloading && percent > 0 ? (
        <div
          className="model-status__bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="model-status__bar-fill" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {status.phase === 'error' && status.message ? (
        <span className="model-status__message">{status.message}</span>
      ) : null}
    </li>
  )
}

interface StatusSectionProps {
  readiness: Readiness
  vlStatus: VlStatusSnapshot | null
  sttStatus: SttStatusSnapshot | null
  ttsStatus: BackendComponentStatus | null
}

function StatusSection({
  readiness,
  vlStatus,
  sttStatus,
  ttsStatus
}: StatusSectionProps): React.JSX.Element {
  const summary = describeGlobalReadiness(readiness)
  const [ttsVoice, setTtsVoice] = useState<string>(DEFAULT_TTS_VOICE)

  useEffect(() => {
    let disposed = false
    void window.api.tts
      .getVoice()
      .then((saved) => {
        if (!disposed) setTtsVoice(saved)
      })
      .catch(() => {
        // Keep the default label if the voice cannot be read.
      })
    return () => {
      disposed = true
    }
  }, [])

  return (
    <div className="question-panel">
      <div className={`readiness readiness--${readiness.level}`}>
        <span className="readiness__dot" aria-hidden="true" />
        <div className="readiness__text">
          <strong className="readiness__title">{summary.title}</strong>
          <span className="settings-hint">{summary.description}</span>
        </div>
      </div>
      {vlStatus || sttStatus || ttsStatus ? (
        <ul className="model-status">
          {vlStatus ? (
            <>
              <ModelStatusRow
                label="llama.cpp runtime"
                version={`build ${vlStatus.llamaVersion} · ${vlStatus.llamaBackend}`}
                status={vlStatus.runtime}
              />
              <ModelStatusRow
                label="Vision model"
                version={`${vlStatus.modelAlias} · ${vlStatus.modelQuant}`}
                status={vlStatus.model}
              />
              <ModelStatusRow
                label="Vision projector"
                version={`mmproj · ${vlStatus.mmprojQuant}`}
                status={vlStatus.mmproj}
              />
              <ModelStatusRow
                label="Inference server"
                version={vlStatus.port ? `127.0.0.1:${vlStatus.port}` : 'Not running'}
                status={vlStatus.server}
              />
            </>
          ) : null}
          {sttStatus ? (
            <>
              <ModelStatusRow
                label="Wake word"
                version="openwakeword · hey bud"
                status={sttStatus.wakeWord}
              />
              <ModelStatusRow
                label="Speech-to-text"
                version="Moonshine small streaming · en"
                status={sttStatus.transcription}
              />
            </>
          ) : null}
          {ttsStatus ? (
            <ModelStatusRow
              label="Text-to-speech"
              version={`Pocket-TTS · voice ${formatVoiceName(ttsVoice)}`}
              status={ttsStatus}
            />
          ) : null}
        </ul>
      ) : (
        <p className="settings-hint">Checking components…</p>
      )}
    </div>
  )
}

export default StatusSection
