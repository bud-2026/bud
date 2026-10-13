import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { DEFAULT_TTS_VOICE, POCKET_TTS_VOICE_GROUPS, formatVoiceName } from '../../lib/voices'

interface VoiceSectionProps {
  isVoiceEnabled: boolean
  onToggleVoice: () => void
  isWriteAnswers: boolean
  onToggleWriteAnswers: (enabled: boolean) => void
  onError: (message: string | null) => void
}

// Fixed sample spoken when previewing a voice so the user can compare them.
const PREVIEW_TEXT = 'Hi, my name is Bud'

function VoiceSection({
  isVoiceEnabled,
  onToggleVoice,
  isWriteAnswers,
  onToggleWriteAnswers,
  onError
}: VoiceSectionProps): React.JSX.Element {
  const [ttsText, setTtsText] = useState('')
  const [isTtsLoading, setIsTtsLoading] = useState(false)
  const [voice, setVoice] = useState<string>(DEFAULT_TTS_VOICE)
  const [isSavingVoice, setIsSavingVoice] = useState(false)
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null)

  // Load the persisted voice so the panel reflects what Bud speaks with.
  useEffect(() => {
    let disposed = false
    void window.api.tts
      .getVoice()
      .then((saved) => {
        if (!disposed) setVoice(saved)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : 'Could not load the selected voice')
      })
    return () => {
      disposed = true
    }
  }, [onError])

  // The preview request resolves as soon as it is sent, so clear the "playing"
  // marker when the backend signals the stream has ended (or failed).
  useEffect(() => {
    const unsubscribeEnd = window.api.tts.onEnd(() => setPreviewingVoice(null))
    const unsubscribeError = window.api.tts.onError(() => setPreviewingVoice(null))
    return () => {
      unsubscribeEnd()
      unsubscribeError()
    }
  }, [])

  const handleSelectVoice = async (next: string): Promise<void> => {
    if (next === voice || isSavingVoice) return

    setIsSavingVoice(true)
    onError(null)
    try {
      setVoice(await window.api.tts.setVoice(next))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not save the selected voice')
    } finally {
      setIsSavingVoice(false)
    }
  }

  const handlePreview = async (target: string): Promise<void> => {
    if (previewingVoice) return

    onError(null)
    setPreviewingVoice(target)
    try {
      await window.api.tts.speak(PREVIEW_TEXT, target)
    } catch (error) {
      setPreviewingVoice(null)
      onError(error instanceof Error ? error.message : 'TTS request failed')
    }
  }

  const handleTtsSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = ttsText.trim()

    if (!text || isTtsLoading) return

    setIsTtsLoading(true)
    onError(null)
    try {
      await window.api.tts.speak(text)
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : 'TTS request failed')
    } finally {
      setIsTtsLoading(false)
    }
  }

  return (
    <div className="settings-section">
      <div className="question-panel">
        <label className="voice-toggle">
          <input type="checkbox" checked={isVoiceEnabled} onChange={onToggleVoice} />
          <span>Enable voice activation (wake word &amp; speech-to-text)</span>
        </label>
        <p className="question-panel__voice-status">
          {isVoiceEnabled
            ? 'Wake word detection and speech-to-text are running.'
            : 'Voice is off · openwakeword and STT are stopped.'}
        </p>
        <label className="voice-toggle">
          <input
            type="checkbox"
            checked={isWriteAnswers}
            onChange={(event) => onToggleWriteAnswers(event.target.checked)}
          />
          <span>Show written answers</span>
        </label>
        <p className="question-panel__voice-status">
          {isWriteAnswers
            ? 'Bud also writes each spoken answer on screen.'
            : 'Bud only speaks its answer out loud.'}
        </p>
      </div>

      <div className="question-panel">
        <label>Voice</label>
        <p className="question-panel__voice-status">
          Bud speaks with <strong>{formatVoiceName(voice)}</strong> · press play to preview
        </p>
        <div className="voice-groups">
          {POCKET_TTS_VOICE_GROUPS.map((group) => (
            <div key={group.label} className="voice-group">
              <span className="voice-group__label">{group.label}</span>
              <ul className="voice-list">
                {group.voices.map((candidate) => {
                  const isSelected = candidate === voice
                  const isPreviewing = candidate === previewingVoice
                  return (
                    <li
                      key={candidate}
                      className={`voice-option${isSelected ? ' voice-option--selected' : ''}`}
                    >
                      <label className="voice-option__choice">
                        <input
                          type="radio"
                          name="tts-voice"
                          checked={isSelected}
                          onChange={() => void handleSelectVoice(candidate)}
                          disabled={isSavingVoice}
                        />
                        <span className="voice-option__name">{formatVoiceName(candidate)}</span>
                      </label>
                      <button
                        type="button"
                        className={`voice-option__play${isPreviewing ? ' voice-option__play--active' : ''}`}
                        onClick={() => void handlePreview(candidate)}
                        disabled={previewingVoice !== null || isSavingVoice}
                        aria-label={`Play a sample of the ${formatVoiceName(candidate)} voice`}
                        title="Play a sample"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width="14"
                          height="14"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <form className="question-panel" onSubmit={handleTtsSubmit}>
        <label htmlFor="tts-text">Test text-to-speech</label>
        <div className="question-panel__controls">
          <input
            id="tts-text"
            value={ttsText}
            onChange={(event) => setTtsText(event.target.value)}
            placeholder="Type text to speak..."
            disabled={isTtsLoading}
          />
          <button type="submit" disabled={isTtsLoading || !ttsText.trim()}>
            Speak
          </button>
        </div>
      </form>
    </div>
  )
}

export default VoiceSection
