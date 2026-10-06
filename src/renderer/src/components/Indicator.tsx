import './Indicator.css'

export interface Point {
  x: number
  y: number
}

export interface IndicatorProps {
  topLeft: Point
  bottomRight: Point
  label?: string
}

function Indicator({ topLeft, bottomRight, label = 'Person' }: IndicatorProps): React.JSX.Element {
  const width = Math.max(0, bottomRight.x - topLeft.x)
  const height = Math.max(0, bottomRight.y - topLeft.y)

  return (
    <div
      className="indicator"
      style={{
        left: topLeft.x,
        top: topLeft.y,
        width,
        height
      }}
      aria-label={`${label} detected`}
    >
      <span className="indicator__pulse" />
      <span className="indicator__label">{label}</span>
    </div>
  )
}

export default Indicator
