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
      <div className="voice-orb__glow" />
      <div className="voice-orb__core">
        <span className="voice-orb__dot" />
        <span className="voice-orb__dot" />
        <span className="voice-orb__dot" />
      </div>
    </div>
  )
}

export default VoiceOrb
