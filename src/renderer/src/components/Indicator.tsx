import './Indicator.css'

export interface IndicatorProps {
  /** [left, top, right, bottom] on the 1000x1000 viewport grid. */
  bbox: [number, number, number, number]
  label?: string
  /** Extra padding around the box, in 1000x1000 grid units. */
  padding?: number
}

function Indicator({ bbox, label = 'Person', padding = 0 }: IndicatorProps): React.JSX.Element {
  const [bboxLeft, bboxTop, bboxRight, bboxBottom] = bbox
  const left = Math.min(1000, Math.max(0, bboxLeft - padding)) / 10
  const top = Math.min(1000, Math.max(0, bboxTop - padding)) / 10
  const right = Math.min(1000, Math.max(bboxLeft, bboxRight + padding)) / 10
  const bottom = Math.min(1000, Math.max(bboxTop, bboxBottom + padding)) / 10

  return (
    <div
      className="indicator"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${right - left}%`,
        height: `${bottom - top}%`
      }}
      aria-label={`${label} detected`}
    >
      <span className="indicator__pulse" />
      <span className="indicator__label">{label}</span>
    </div>
  )
}

export default Indicator
