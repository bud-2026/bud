interface ApplicationSectionProps {
  onQuit: () => void
}

function ApplicationSection({ onQuit }: ApplicationSectionProps): React.JSX.Element {
  return (
    <div className="question-panel">
      <div className="question-panel__controls">
        <button type="button" className="question-panel__quit" onClick={onQuit} title="Close Bud">
          Quit Bud
        </button>
      </div>
    </div>
  )
}

export default ApplicationSection
