interface AnswerCaptionProps {
  /** The answer text Bud is currently speaking, written out on screen. */
  text: string
  /** Mirrors the voice orb so the caption pops and hides with it. */
  exiting?: boolean
}

function AnswerCaption({ text, exiting = false }: AnswerCaptionProps): React.JSX.Element {
  return (
    <p
      className={`answer-caption${exiting ? ' answer-caption--hiding' : ''}`}
      role="status"
      aria-live="polite"
    >
      {text}
    </p>
  )
}

export default AnswerCaption
