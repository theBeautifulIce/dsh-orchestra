import { COLOR, FONT_PX } from './tokens.ts'

export const TASK_WORKSPACE_CSS = `
.task-workspace { min-width: 0; }
.task-list { display: grid; gap: 16px; min-width: 0; }
.task-page-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px; }
.task-launch-form { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; border: 1px solid ${COLOR.line}; border-radius: 8px; padding: 10px; }
.task-launch-form label { display: grid; gap: 3px; font-size: ${FONT_PX.menu}px; }
.task-launch-form input, .task-launch-form select, .task-launch-form button { max-width: 100%; min-height: 32px; padding: 4px 8px; font: inherit; background: ${COLOR.surface}; border: 1px solid ${COLOR.line}; border-radius: 5px; }
.task-launch-form p { margin: 0; flex-basis: 100%; color: ${COLOR.inkMuted}; }
.task-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid ${COLOR.line}; border-radius: 8px; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; }
.task-toolbar > span { margin-right: auto; }
.task-toolbar label, .task-date-range { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.task-toolbar select, .task-toolbar input[type=date], .task-view-group button, .task-flow-view button { padding: 6px 9px; background: ${COLOR.surface}; border: 1px solid ${COLOR.line}; border-radius: 6px; color: ${COLOR.ink}; font: inherit; }
.task-archive-toggle { margin-left: auto; }
.task-view-group { display: flex; flex-wrap: wrap; gap: 4px; }
.task-view-group button, .task-flow-view button { cursor: pointer; }
.task-view-group [aria-pressed=true], .task-flow-picker [aria-pressed=true] { background: #eff3f8; border-color: #c2d0df; font-weight: 650; }
.task-search { display: flex; gap: 6px; min-width: 0; max-width: 100%; }
.task-search input { box-sizing: border-box; max-width: 100%; }
.task-board-scroll { container-type: inline-size; overflow-x: auto; min-width: 0; padding: 1px 1px 5px; }
.task-board { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 9px; align-items: stretch; }
.task-column { min-width: 0; min-height: 258px; display: flex; flex-direction: column; gap: 8px; padding: 9px; background: #f7f8fa; border: 1px solid ${COLOR.line}; border-radius: 10px; }
.task-column-title { display: flex; align-items: center; justify-content: space-between; gap: 5px; min-height: 27px; margin: 0 0 1px; padding-bottom: 7px; border-bottom: 1px solid ${COLOR.line}; font-size: ${FONT_PX.body}px; }
.task-column-title span { min-width: 20px; text-align: center; padding: 0 3px; border: 1px solid ${COLOR.line}; border-radius: 5px; color: ${COLOR.inkMuted}; background: ${COLOR.surface}; font-size: ${FONT_PX.helper}px; font-variant-numeric: tabular-nums; }
.task-column-empty { margin: 12px 0; text-align: center; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; }
.task-card { position: relative; min-width: 0; border: 1px solid ${COLOR.line}; border-radius: 8px; padding: 10px; background: ${COLOR.surface}; overflow-wrap: anywhere; }
.task-card:hover { border-color: #92a8c0; }
.task-card[data-selected] { background: #f1f6fd; border-color: #7f9ebf; }
.task-card-title { margin: 7px 0 5px; }
.task-card-title button::after { content: ''; position: absolute; inset: 0; border-radius: 8px; }
.task-card-title button:focus-visible::after { outline: 2px solid ${COLOR.link}; outline-offset: 1px; }
.task-card-status, .task-card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 9px; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; }
.task-card-status { justify-content: space-between; }
.task-card-status > :first-child { padding: 1px 5px; border-radius: 4px; background: #f2f4f6; font-weight: 650; }
.task-card-reason { margin: 5px 0 0; font-size: ${FONT_PX.menu}px; color: ${COLOR.inkMuted}; }
.task-card-type { margin: 3px 0; font-size: ${FONT_PX.helper}px; color: ${COLOR.inkMuted}; }
.task-card-attention { display: grid; gap: 2px; margin-top: 8px; padding: 5px 6px; border: 1px solid #eee2cc; border-radius: 5px; background: #fff9ee; color: ${COLOR.warning}; font-size: ${FONT_PX.helper}px; }
.task-card-meta { margin-top: 8px; padding-top: 7px; border-top: 1px solid ${COLOR.line}; }
.task-card-steps { position: relative; z-index: 1; margin-top: 8px; }
.task-card-steps button:focus-visible { outline: 2px solid ${COLOR.link}; outline-offset: 2px; }
.task-step-overview { display: grid; gap: 0; list-style: none; margin: 0; padding: 0; }
.task-step-overview li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 7px; min-width: 0; padding: 6px 0; border-top: 1px solid ${COLOR.line}; overflow-wrap: anywhere; }
.task-step-overview li > * { min-width: 0; max-width: 100%; }
.task-step-overview-status, .task-step-overview small { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; }
.task-step-overview [data-tone=active] .task-step-overview-status { color: ${COLOR.link}; }
.task-step-overview [data-tone=blocked] .task-step-overview-status { color: ${COLOR.warning}; }
.task-step-overview [data-tone=failed] .task-step-overview-status { color: ${COLOR.danger}; }
.task-step-waiting { flex-basis: 100%; }
.task-card-steps > div { margin-top: 6px; }
.task-queue-groups { display: grid; gap: 10px; }
.task-queue-groups h3 { margin: 0; font-size: ${FONT_PX.body}px; }
.task-queue-groups .task-step-overview li { padding: 7px 12px; }
@container (max-width: 720px) { .task-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 420px) { .task-board { grid-template-columns: minmax(0, 1fr); } .task-column { min-height: 0; } }
.task-table-scroll { overflow-x: auto; border: 1px solid ${COLOR.line}; border-radius: 9px; }
.task-table { width: 100%; min-width: 530px; border-collapse: collapse; font-size: ${FONT_PX.menu}px; text-align: left; }
.task-table th, .task-table td { padding: 10px 12px; border-bottom: 1px solid ${COLOR.line}; overflow-wrap: anywhere; }
.task-table th { background: #f5f7f9; }
.task-table tr[data-selected] { background: #f1f6fd; }
.task-table small { display: block; font-size: ${FONT_PX.helper}px; color: ${COLOR.inkMuted}; }
.task-link { border: 0; padding: 0; color: ${COLOR.link}; background: transparent; font: inherit; font-weight: 650; cursor: pointer; text-align: left; }
.task-page-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.task-plan-entry { display: grid; justify-items: start; min-width: 0; }
.task-plan-entry > details[open] { width: min(100%, 720px); box-sizing: border-box; }
.task-plan-entry summary { cursor: pointer; }
.task-flow-view { display: grid; grid-template-columns: minmax(156px, 22%) minmax(0, 1fr); gap: 14px; align-items: start; container-type: inline-size; }
.task-flow-main { min-width: 0; display: grid; gap: 12px; }
.task-flow-picker, .task-flow-run-head, .task-flow-graph { min-width: 0; border: 1px solid ${COLOR.line}; border-radius: 10px; background: ${COLOR.surface}; }
.task-flow-picker { display: grid; overflow: auto; max-height: calc(100dvh - 40px); }
.task-flow-picker button.task-flow-pick { min-width: 0; display: grid; gap: 4px; text-align: left; overflow-wrap: anywhere; padding: 10px 12px; border: 0; border-top: 1px solid ${COLOR.line}; border-radius: 0; }
.task-flow-pick > span:last-child, .task-flow-pick-meta, .task-flow-section-head span, .task-run-facts dt { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; }
.task-flow-pick-meta { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 5px 8px; }
.task-type-badge { display: inline-flex; padding: 1px 6px; align-items: center; background: #eef2f7; color: #34465f; border-radius: 5px; }
.task-flow-section-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; padding: 10px 12px; }
.task-flow-run-head { display: grid; justify-items: start; gap: 6px; padding: 15px 17px; }
.task-flow-run-head h2 { margin: 0; font-size: ${FONT_PX.title}px; line-height: 1.3; }
.task-flow-run-head p { margin: 0; color: ${COLOR.inkMuted}; }
.task-run-facts { display: flex; flex-wrap: wrap; gap: 7px 16px; margin: 0; padding: 7px 0; }
.task-run-facts dd { margin: 0; font-weight: 600; }
.task-flow-empty { margin: 0; padding: 9px 12px; overflow-wrap: anywhere; color: ${COLOR.inkMuted}; }
.task-flow-empty button { margin-inline-start: 7px; }
.task-quiet-button { min-height: 33px; padding: 5px 10px; border-radius: 6px; border: 1px solid ${COLOR.line}; background: ${COLOR.surface}; color: ${COLOR.ink}; font: inherit; cursor: pointer; }
.task-flow-pick:focus-visible { outline: 2px solid ${COLOR.link}; outline-offset: -2px; }
.task-quiet-button:hover { border-color: #91a5be; }
.task-flow-graph { overflow: hidden; }
.task-flow-graph > [data-canvas-root] { min-width: 0; max-width: 100%; grid-template-columns: minmax(0, 1fr); }
.task-flow-graph summary { padding: 10px 12px; cursor: pointer; font-weight: 600; }
.task-flow-graph[open] { padding-bottom: 8px; }
@media (max-width: 900px) {
  .task-flow-view { grid-template-columns: minmax(0, 1fr); }
  .task-flow-picker { display: flex; max-height: none; }
  .task-flow-picker > header { display: none; }
  .task-flow-picker button.task-flow-pick { min-width: 174px; border-top: 0; border-right: 1px solid ${COLOR.line}; }
}
`


export const TASK_RUN_STEPS_CSS = `
.task-run-steps {
  container: task-run-steps / inline-size; min-width: 0; align-self: start;
  border: 1px solid ${COLOR.line}; border-radius: 9px; background: ${COLOR.surface};
}
.task-run-steps-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  padding: 9px 12px; border-bottom: 1px solid ${COLOR.line};
}
.task-run-steps-head h3, .task-run-steps-head p { margin: 0; }
.task-run-steps-head h3 { font-size: ${FONT_PX.section}px; }
.task-run-steps-head p, .task-run-steps-head > span { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; }
.task-run-steps-head > span { margin-inline-start: auto; }
.task-step-totals { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 0; padding: 6px 12px; list-style: none; border-bottom: 1px solid ${COLOR.line}; }
.task-step-totals li { font-size: ${FONT_PX.menu}px; color: ${COLOR.inkMuted}; }
.task-step-totals [data-tone=blocked], .task-step-head [data-tone=blocked], .task-flow-step[data-tone=blocked] .task-flow-step-result { color: ${COLOR.warning}; }
.task-step-totals [data-tone=active], .task-step-head [data-tone=active], .task-flow-step[data-tone=active] .task-flow-step-result { color: ${COLOR.link}; }
.task-step-head [data-tone=failed], .task-flow-step[data-tone=failed] .task-flow-step-result { color: ${COLOR.danger}; }
.task-step-head [data-tone=done] { color: ${COLOR.success}; }
.task-run-grid { min-width: 0; display: grid; grid-template-columns: minmax(0, 40%) minmax(0, 1fr); align-items: start; }
.task-run-grid[data-single=true] { grid-template-columns: minmax(0, 1fr); }
.task-flow-steps {
  margin: 0; padding: 0; list-style: none; min-width: 0; max-block-size: min(35vh, 350px);
  overflow: auto; scrollbar-gutter: stable; border-inline-end: 1px solid ${COLOR.line};
}
.task-flow-trigger-record { margin: 0; padding: 6px 12px; border-bottom: 1px solid ${COLOR.line}; color: ${COLOR.inkMuted}; }
.task-flow-steps .task-flow-step {
  display: grid; grid-template-columns: 25px minmax(0, 1fr) fit-content(40%); align-items: center;
  min-block-size: 34px; gap: 6px; width: 100%; text-align: left; color: ${COLOR.ink};
  background: ${COLOR.surface}; cursor: pointer; overflow-wrap: anywhere; padding: 5px 8px;
  border: 0; border-bottom: 1px solid ${COLOR.line}; border-radius: 0; font: inherit;
}
.task-flow-steps .task-flow-step[aria-pressed=true] { background: #eef4fc; box-shadow: inset 3px 0 #6385b2; }
.task-flow-step:focus-visible, .task-step-more summary:focus-visible { outline: 2px solid ${COLOR.link}; outline-offset: -2px; }
.task-flow-step-number { text-align: center; color: ${COLOR.inkMuted}; font-variant-numeric: tabular-nums; }
.task-flow-step-number, .task-flow-step-result, .task-step-meta, .task-step-model span { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; }
.task-step-inspector { min-width: 0; }
.task-step-inspect-body { display: grid; justify-items: stretch; gap: 7px; padding: 9px 12px; overflow-wrap: anywhere; }
.task-step-inspect-body p, .task-step-inspect-body h4, .task-step-inspect-body h5 { margin: 0; }
.task-step-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.task-step-head h4 { font-size: ${FONT_PX.section}px; }
.task-step-head span { color: ${COLOR.inkMuted}; font-weight: 600; }
.task-step-attention { padding: 5px 8px; border-radius: 5px; background: #f3f6fa; }
.task-step-attention[data-tone=blocked] { background: #fff7e8; color: ${COLOR.warning}; }
.task-step-attention[data-tone=failed] { background: #fff1f1; color: ${COLOR.danger}; }
.task-step-dependencies { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 8px; margin: 0; }
.task-step-dependencies dt { color: ${COLOR.inkMuted}; }
.task-step-dependencies dd { margin: 0; }
.task-step-model { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
.task-step-more { border-top: 1px solid ${COLOR.line}; }
.task-step-more summary { padding: 6px 0; cursor: pointer; color: ${COLOR.link}; }
.task-step-more-body { display: grid; gap: 8px; padding: 3px 0 6px; }
.task-step-more-body h5 { font-size: ${FONT_PX.menu}px; }
.task-step-inspect-body > button { justify-self: start; }
@container task-run-steps (max-width: 640px) {
  .task-run-grid { grid-template-columns: minmax(0, 1fr); }
  .task-flow-steps { max-block-size: min(32vh, 176px); border-inline-end: 0; border-block-end: 1px solid ${COLOR.line}; }
}
`

export const TASK_INSPECTOR_CSS = `
.task-inspector { box-sizing: border-box; position: fixed; inset: 0; margin: auto; width: min(1160px, calc(100vw - 48px)); height: min(880px, calc(100dvh - 48px)); padding: 0; overflow: hidden; background: ${COLOR.surface}; color: ${COLOR.ink}; border: 1px solid #d8dee8; border-radius: 14px; box-shadow: 0 24px 72px #172c4933; overflow-wrap: anywhere; }
.task-inspector[open] { display: flex; flex-direction: column; }
.task-inspector:has(.task-run-grid[data-single=true]) { height: fit-content; max-height: min(880px, calc(100dvh - 48px)); }
.task-inspector::backdrop { background: #111c36a0; }
.task-inspector-top { flex: none; background: #f8fafc; border-bottom: 1px solid ${COLOR.line}; padding: 22px 24px 0; }
.task-inspector-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.task-inspector-content { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; padding: 22px 24px; display: grid; gap: 16px; align-content: start; }
.task-inspector-kicker { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; margin: 0 0 5px; }
.task-inspector-badges { display: flex; flex-wrap: wrap; gap: 4px 7px; align-items: center; margin-top: 7px; font-size: ${FONT_PX.menu}px; }
.task-inspector-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin-top: 10px; }
.task-inspector-tabs button { min-height: 39px; padding: 0 9px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.body}px; cursor: pointer; }
.task-inspector-tabs [aria-pressed=true] { color: ${COLOR.ink}; border-bottom-color: ${COLOR.link}; font-weight: 650; }
.task-inspector-select { display: grid; gap: 4px; margin-top: 9px; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; }
.task-inspector-select select { min-width: 0; max-width: 100%; background: ${COLOR.surface}; border: 1px solid ${COLOR.line}; border-radius: 6px; padding: 5px; font: inherit; color: ${COLOR.ink}; }
.task-archive-actions { margin-top: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.task-archive-actions p { flex-basis: 100%; margin: 3px 0; color: ${COLOR.inkMuted}; }
.task-drawer-section { min-width: 0; display: grid; gap: 7px; }
.task-drawer-section > header { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
.task-drawer-section h3 { margin: 0; font-size: ${FONT_PX.section}px; }
.task-drawer-card { min-width: 0; padding: 11px; border: 1px solid ${COLOR.line}; border-radius: 8px; background: ${COLOR.surface}; }
.task-schedule-card { background: #f4f7fb; }
.task-drawer-card .task-run-facts { padding: 0; }
.task-schedule-card .task-run-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.task-run-history { min-width: 0; display: grid; overflow: hidden; border: 1px solid ${COLOR.line}; border-radius: 8px; }
.task-run-history button { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) auto; gap: 7px; align-items: center; min-width: 0; padding: 8px 10px; min-height: 43px; text-align: left; overflow-wrap: anywhere; border: 0; border-bottom: 1px solid ${COLOR.line}; background: ${COLOR.surface}; color: ${COLOR.ink}; font: inherit; cursor: pointer; }
.task-run-history button:last-child { border-bottom: 0; }
.task-run-history button:hover, .task-run-history button[aria-current=true] { background: #eef4fc; }
.task-run-history button small { display: block; color: ${COLOR.inkMuted}; }
.task-inspector-back { margin-bottom: 5px; }
.task-inspector-status { padding: 4px 0; color: ${COLOR.inkMuted}; }
@media (max-width: 660px) {
  .task-inspector { width: calc(100vw - 18px); height: calc(100dvh - 18px); }
  .task-inspector:has(.task-run-grid[data-single=true]) { max-height: calc(100dvh - 18px); }
  .task-inspector-top, .task-inspector-content { padding-inline: 12px; }
}
`
