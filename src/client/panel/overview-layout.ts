import { COLOR, FONT_PX } from './tokens.ts'

/** Overview styles stay inside the plugin's viewport, including in the embedded DSH host. */
export const OVERVIEW_LAYOUT_CSS = `
.ops-panel-viewport .ops-overview { gap: 28px; }
.ops-panel-viewport .ops-overview-eyebrow { margin: 0 0 7px; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; font-weight: 650; letter-spacing: .11em; }
.ops-panel-viewport .ops-overview-intro { margin: 10px 0 0; color: ${COLOR.inkMuted}; line-height: 1.7; }
.ops-panel-viewport .ops-overview-section { display: grid; gap: 14px; min-width: 0; }
.ops-panel-viewport .ops-overview-section-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.ops-panel-viewport .ops-overview-section-head p, .ops-panel-viewport .ops-overview .ops-surface-head p { margin: 5px 0 0; }
.ops-panel-viewport .ops-overview-signals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.ops-panel-viewport .ops-overview-signal { display: grid; gap: 8px; min-width: 0; padding: 19px 20px; border: 1px solid ${COLOR.line}; border-radius: 12px; background: ${COLOR.surface}; color: ${COLOR.ink}; text-align: start; font: inherit; cursor: pointer; }
.ops-panel-viewport .ops-overview-signal-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; }
.ops-panel-viewport .ops-overview-signal strong { font-size: ${FONT_PX.metric}px; font-weight: 650; line-height: 1.25; font-variant-numeric: tabular-nums; }
.ops-panel-viewport .ops-overview-signal[data-tone="warning"] { border-color: #eddcc0; background: #fffdf8; }
.ops-panel-viewport .ops-overview-signal[data-tone="warning"] strong { color: ${COLOR.warning}; }
.ops-panel-viewport .ops-overview-signal[data-tone="blue"] { border-color: #d4e1fc; background: #f7faff; }
.ops-panel-viewport .ops-overview-signal[data-tone="blue"] strong { color: ${COLOR.link}; }
.ops-panel-viewport .ops-overview-signal:hover, .ops-panel-viewport .ops-overview-shortcut:hover { border-color: #a9bde8; background: #f7faff; }
.ops-panel-viewport .ops-overview-columns { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.ops-panel-viewport .ops-overview-task { display: flex; align-items: center; gap: 16px; padding: 19px 20px; min-width: 0; }
.ops-panel-viewport .ops-overview-task + .ops-overview-task { border-top: 1px solid ${COLOR.line}; }
.ops-panel-viewport .ops-overview-task-body { min-width: 0; flex: 1; }
.ops-panel-viewport .ops-overview-task-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.ops-panel-viewport .ops-overview-task-title { padding: 3px 0; border: 0; background: none; color: ${COLOR.ink}; font: inherit; font-weight: 650; text-align: start; overflow-wrap: anywhere; cursor: pointer; }
.ops-panel-viewport .ops-overview-task-title:hover { color: ${COLOR.link}; text-decoration: underline; text-underline-offset: 3px; }
.ops-panel-viewport .ops-overview-task-reason { margin: 7px 0; color: ${COLOR.inkMuted}; line-height: 1.6; overflow-wrap: anywhere; }
.ops-panel-viewport .ops-overview-task-meta { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-top: 8px; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; }
.ops-panel-viewport .ops-overview-task-meta time { overflow-wrap: anywhere; }
.ops-panel-viewport .ops-overview-task-action { flex: 0 1 auto; color: ${COLOR.link}; border-color: #d4e1fc; background: #f7faff; white-space: normal; }
.ops-panel-viewport .ops-overview-progress { height: 4px; margin-top: 13px; max-width: 260px; border-radius: 4px; background: #edf0f5; overflow: hidden; }
.ops-panel-viewport .ops-overview-progress > span { display: block; height: 100%; border-radius: inherit; background: ${COLOR.link}; }
.ops-panel-viewport .ops-overview-shortcuts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.ops-panel-viewport .ops-overview-shortcut { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 18px 20px; border: 1px solid ${COLOR.line}; border-radius: 12px; background: ${COLOR.surface}; color: ${COLOR.ink}; text-align: start; font: inherit; cursor: pointer; }
.ops-panel-viewport .ops-overview-shortcut strong { display: block; margin-bottom: 5px; font-size: ${FONT_PX.body}px; }
.ops-panel-viewport .ops-overview-shortcut .ops-meta { display: block; line-height: 1.6; }
.ops-panel-viewport .ops-overview-link { min-height: 44px; padding: 6px 0; border: 0; background: none; color: ${COLOR.link}; font: inherit; font-size: ${FONT_PX.menu}px; cursor: pointer; }
.ops-panel-viewport .ops-overview-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.ops-panel-viewport .ops-overview-workflow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 17px 20px; min-width: 0; }
.ops-panel-viewport .ops-overview-workflow + .ops-overview-workflow { border-top: 1px solid ${COLOR.line}; }
.ops-panel-viewport .ops-overview-workflow > div { min-width: 0; overflow-wrap: anywhere; }
.ops-panel-viewport .ops-overview-workflow p { margin: 5px 0 0; }
.ops-panel-viewport .ops-overview-empty { margin: 0; padding: 22px 20px; color: ${COLOR.inkMuted}; line-height: 1.7; }
.ops-panel-viewport .ops-overview-notice { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 18px; border: 1px solid #eddcc0; border-radius: 12px; background: #fffdf8; color: ${COLOR.warning}; }
@container orchestra-panel (max-width: 1080px) {
  .ops-panel-viewport .ops-overview-columns { grid-template-columns: minmax(0, 1fr); }
}
@container orchestra-panel (max-width: 700px) {
  .ops-panel-viewport .ops-overview { gap: 24px; }
  .ops-panel-viewport .ops-overview-intro { font-size: ${FONT_PX.reading}px; }
  .ops-panel-viewport .ops-overview-signals, .ops-panel-viewport .ops-overview-shortcuts { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .ops-panel-viewport .ops-overview-signal { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 16px; }
  .ops-panel-viewport .ops-overview-signal-top { grid-column: 1; }
  .ops-panel-viewport .ops-overview-signal-top > span:last-child { display: none; }
  .ops-panel-viewport .ops-overview-signal > strong { grid-column: 2; grid-row: 1 / 3; align-self: center; }
  .ops-panel-viewport .ops-overview-signal > .ops-meta { grid-column: 1; }
  .ops-panel-viewport .ops-overview-task { flex-wrap: wrap; gap: 12px; padding: 17px 16px; }
  .ops-panel-viewport .ops-overview-task-body { flex-basis: 100%; }
  .ops-panel-viewport .ops-overview-task-title { min-height: 44px; font-size: ${FONT_PX.reading}px; }
  .ops-panel-viewport .ops-overview-task-action { width: 100%; justify-content: center; }
  .ops-panel-viewport .ops-overview-shortcut { min-height: 80px; padding: 16px; }
}
`
