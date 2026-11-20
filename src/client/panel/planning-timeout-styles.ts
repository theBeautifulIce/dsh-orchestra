import { COLOR, FONT_PX } from './tokens.ts'

export const PLANNING_TIMEOUT_STYLES = `
.planning-timeouts { container: planning-timeouts / inline-size; }
.planning-timeouts-form { display: grid; gap: 16px; padding: 14px 16px; }
.planning-timeouts-intro, .planning-timeouts-status, .planning-timeouts-context p { margin: 0; }
.planning-timeouts-context {
  display: grid; gap: 8px; padding: 9px 12px;
  background: #f5f8fc; border: 1px solid #e3e9f1; border-radius: 7px;
  font-size: ${FONT_PX.menu}px;
}
.planning-timeouts-context dl { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 0; }
.planning-timeouts-context dl div { display: flex; gap: 6px; }
.planning-timeouts-context dt { color: ${COLOR.inkMuted}; }
.planning-timeouts-context dd { margin: 0; font-weight: 650; }
.planning-timeouts-group { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
.planning-timeouts-group legend {
  padding: 0; margin-block-end: 3px; font-weight: 700; font-size: ${FONT_PX.section}px;
}
.planning-timeouts-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start;
  column-gap: 16px; row-gap: 3px; padding-block: 10px; border-top: 1px solid ${COLOR.line};
}
.planning-timeouts-row label { font-weight: 650; align-self: center; grid-column: 1; grid-row: 1; }
.planning-timeouts-value {
  grid-column: 2; grid-row: 1 / span 2; display: flex; align-items: center;
  gap: 7px; font-variant-numeric: tabular-nums;
}
.planning-timeouts-value input { inline-size: 7ch; min-inline-size: 66px; }
.planning-timeouts-value input[aria-invalid=true] { border-color: ${COLOR.danger}; }
.planning-timeouts-value span, .planning-timeouts-help { color: ${COLOR.inkMuted}; }
.planning-timeouts-help { grid-column: 1; font-size: ${FONT_PX.menu}px; }
.planning-timeouts-help p { margin: 0; }
.planning-timeouts-help p + p { margin-block-start: 2px; font-size: ${FONT_PX.helper}px; }
.planning-timeouts-footer { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid ${COLOR.line}; }
.planning-timeouts-status { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; }
.planning-timeouts-status[role=alert] { color: ${COLOR.danger}; }
@container planning-timeouts (max-width: 460px) {
  .planning-timeouts-form { padding-inline: 12px; }
  .planning-timeouts-row { row-gap: 6px; }
  .planning-timeouts-value { grid-row: 1; }
  .planning-timeouts-help { grid-column: 1 / -1; }
}
`
