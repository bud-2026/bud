import './Indicator.css'

export interface Point {
  /** Percentage of the viewport, from 0 to 100. */
  x: number
  /** Percentage of the viewport, from 0 to 100. */
  y: number
}

export interface IndicatorProps {
  topLeft: Point
  bottomRight: Point
  label?: string
  /** Extra padding around the box, in viewport percentage points. */
  padding?: number
}

function Indicator({
  topLeft,
  bottomRight,
  label = 'Person',
  padding = 0.5
}: IndicatorProps): React.JSX.Element {
  const left = Math.min(100, Math.max(0, topLeft.x - padding))
  const top = Math.min(100, Math.max(0, topLeft.y - padding))
  const right = Math.min(100, Math.max(left, bottomRight.x + padding))
  const bottom = Math.min(100, Math.max(top, bottomRight.y + padding))

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
