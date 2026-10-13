import type { FormEvent } from 'react'

interface DebugSectionProps {
  voiceStatus: string
  region: Region | null
  isAutoListen: boolean
  isSelecting: boolean
  isVoiceEnabled: boolean
  onRegionControlClick: () => void
  onClearRegion: () => void
  question: string
  onQuestionChange: (value: string) => void
  onAskSubmit: (event: FormEvent<HTMLFormElement>) => void
  isLoading: boolean
  result: ScreenAIResponse | null
  voiceTranscript: string
}

function DebugSection({
  voiceStatus,
  region,
  isAutoListen,
  isSelecting,
  isVoiceEnabled,
  onRegionControlClick,
  onClearRegion,
  question,
  onQuestionChange,
  onAskSubmit,
  isLoading,
  result,
  voiceTranscript
}: DebugSectionProps): React.JSX.Element {
  return (
    <form className="question-panel" onSubmit={onAskSubmit}>
      <p className="settings-hint">{voiceStatus}</p>
      <div className="region-control">
        <span className="settings-heading">Screen area</span>
        <div className="region-control__buttons">
          <button type="button" onClick={onRegionControlClick} disabled={isSelecting}>
            {isSelecting
              ? 'Selecting…'
              : region
                ? !isVoiceEnabled
                  ? 'Reselect area'
                  : isAutoListen
                    ? 'Stop listening'
                    : 'Start listening'
                : 'Select area to analyze'}
          </button>
          {region ? (
            <button
              type="button"
              className="settings-button--danger"
              onClick={onClearRegion}
              disabled={isSelecting}
            >
              Clear area
            </button>
          ) : null}
        </div>
        <span className="settings-hint">
          {region
            ? isAutoListen
              ? `Area selected (${region.width}×${region.height} of 1000) · auto-listening · Esc or × to clear`
              : `Area selected (${region.width}×${region.height} of 1000) · Esc or × to clear`
            : 'Analyzing the full screen'}
        </span>
      </div>
      <div className="question-panel__controls">
        <input
          id="screen-question"
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          placeholder="What is on my screen?"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !question.trim()}>
          Ask
        </button>
      </div>
      {result && <p className="question-panel__response">{result.text}</p>}
      {voiceTranscript && <p className="settings-hint">Heard: {voiceTranscript}</p>}
    </form>
  )
}

export default DebugSection
