interface VoiceOrbProps {
  state: 'listening' | 'analyzing' | 'responding'
  exiting?: boolean
}

function VoiceOrb({ state, exiting = false }: VoiceOrbProps): React.JSX.Element {
  return (
    <div
      className={`voice-orb voice-orb--${state}${exiting ? ' voice-orb--hiding' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`${state} state`}
    >
      <div className="voice-orb__antenna">
        <span />
      </div>
      <div className="voice-orb__ear voice-orb__ear--left" />
      <div className="voice-orb__ear voice-orb__ear--right" />
      <div className="voice-orb__shell">
        <div className="voice-orb__screen">
          {state === 'listening' && (
            <span className="voice-orb__microphone" aria-hidden="true">
              <span className="voice-orb__microphone-body" />
              <span className="voice-orb__microphone-stand" />
            </span>
          )}
          {state === 'analyzing' && (
            <span className="voice-orb__scanner" aria-hidden="true">
              <span className="voice-orb__scanner-ring" />
              <span className="voice-orb__scanner-sweep" />
              <span className="voice-orb__scanner-dot voice-orb__scanner-dot--one" />
              <span className="voice-orb__scanner-dot voice-orb__scanner-dot--two" />
              <span className="voice-orb__scanner-dot voice-orb__scanner-dot--three" />
            </span>
          )}
          {state === 'responding' && (
            <span className="voice-orb__face" aria-hidden="true">
              <span className="voice-orb__eye" />
              <span className="voice-orb__eye" />
              <span className="voice-orb__mouth" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default VoiceOrb
