const S = (type, x, y, props, extra = {}) => {
  const nextProps = { ...props }
  if (Object.prototype.hasOwnProperty.call(nextProps, 'text')) {
    nextProps.richText = tldraw.toRichText(nextProps.text)
    delete nextProps.text
  }
  return { id: tldraw.createShapeId(), type, x, y, props: nextProps, ...extra }
}

const shapes = []
const geo = (x, y, w, h, text, color = 'grey', fill = 'solid', size = 'm') =>
  shapes.push(S('geo', x, y, { geo: 'rectangle', w, h, color, fill, dash: 'draw', size, text, align: 'middle', verticalAlign: 'middle' }))
const text = (x, y, w, textValue, size = 'm', color = 'black', align = 'start') =>
  shapes.push(S('text', x, y, { w, color, size, text: textValue, textAlign: align, autoSize: false }))
const arrow = (x, y, dx, dy, color = 'grey') =>
  shapes.push(S('arrow', x, y, { start: { x: 0, y: 0 }, end: { x: dx, y: dy }, color, size: 'm', arrowheadEnd: 'arrow' }))

// Header
text(900, 390, 920, '30-DAY COST FORECAST', 'xl', 'black', 'middle')
text(900, 445, 920, 'Based only on the snapshot shown — not a billing guarantee', 'm', 'grey', 'middle')

// Input cards around the source image
geo(650, 695, 250, 110, 'TRAILING 30 DAYS\n$3,242.54', 'blue', 'semi', 'm')
geo(650, 825, 250, 105, 'TOKENS\n260M', 'blue', 'semi', 'm')
geo(1360, 695, 280, 110, 'TODAY\n$264.72', 'orange', 'semi', 'm')
geo(1360, 825, 280, 105, 'RECENT SIGNAL\nSharp upward spike', 'orange', 'semi', 'm')
text(965, 950, 330, 'SOURCE SNAPSHOT', 's', 'grey', 'middle')

arrow(905, 750, 65, 0, 'blue')
arrow(1350, 750, -60, 0, 'orange')

// Calculations
geo(650, 1030, 990, 310, '', 'grey', 'semi', 'm')
text(700, 1065, 890, 'SHOWING THE WORK', 'l', 'black', 'middle')
text(710, 1130, 410, 'BASELINE RUN RATE\n$3,242.54 ÷ 30\n= $108.08 / day', 'm', 'blue', 'middle')
text(1170, 1130, 410, 'TODAY RUN RATE\n$264.72 × 30\n= $7,941.60 / 30 days', 'm', 'orange', 'middle')
text(760, 1260, 770, 'Blended daily rate = 60% × $108.08 + 40% × $264.72 = $170.74/day', 'm', 'black', 'middle')

arrow(1145, 1355, 0, 95, 'green')

// Forecast hero
geo(825, 1470, 640, 245, '', 'green', 'semi', 'l')
text(875, 1505, 540, 'NEXT 30 DAYS — POINT ESTIMATE', 'm', 'green', 'middle')
text(875, 1560, 540, '$5,122', 'xl', 'green', 'middle')
text(875, 1640, 540, '$170.74/day × 30 = $5,122.20', 'm', 'black', 'middle')

// Scenario range
text(705, 1790, 880, 'PLAUSIBLE RANGE', 'l', 'black', 'middle')
geo(650, 1850, 300, 170, 'LOW\n$3.2K\nUsage returns to 30d average', 'blue', 'semi', 'm')
geo(980, 1850, 300, 170, 'BASE\n$5.1K\nBaseline + recent acceleration', 'green', 'semi', 'm')
geo(1310, 1850, 330, 170, 'HIGH\n$7.9K\nToday’s pace persists', 'orange', 'semi', 'm')

// Simple forecast line diagram
text(690, 2100, 910, 'DIRECTIONAL FORECAST', 'l', 'black', 'middle')
shapes.push(S('arrow', 720, 2305, { start: { x: 0, y: 0 }, end: { x: 820, y: 0 }, color: 'grey', size: 'm', arrowheadEnd: 'none' }))
shapes.push(S('arrow', 720, 2170, { start: { x: 0, y: 135 }, end: { x: 0, y: 0 }, color: 'grey', size: 'm', arrowheadEnd: 'none' }))
shapes.push(S('arrow', 735, 2290, { start: { x: 0, y: 0 }, end: { x: 190, y: -5 }, color: 'green', size: 'l', arrowheadEnd: 'none' }))
shapes.push(S('arrow', 925, 2285, { start: { x: 0, y: 0 }, end: { x: 190, y: -20 }, color: 'green', size: 'l', arrowheadEnd: 'none' }))
shapes.push(S('arrow', 1115, 2265, { start: { x: 0, y: 0 }, end: { x: 190, y: -35 }, color: 'green', size: 'l', arrowheadEnd: 'none' }))
shapes.push(S('arrow', 1305, 2230, { start: { x: 0, y: 0 }, end: { x: 220, y: -40 }, color: 'green', size: 'l', arrowheadEnd: 'arrow' }))
text(700, 2320, 180, 'NOW\n$3.24K trailing', 's', 'grey', 'start')
text(1370, 2320, 200, '+30 DAYS\n≈ $5.12K', 's', 'green', 'end')
text(690, 2415, 910, 'Confidence: LOW–MODERATE. The image gives one 30-day total and one daily observation; workload changes can move the result quickly.', 's', 'grey', 'middle')

await tldraw.createShapesSafely(shapes)
editor.zoomToBounds({ x: 600, y: 340, w: 1100, h: 2160 }, { animation: { duration: 400 } })
return { created: shapes.length, forecast: 5122.20 }
