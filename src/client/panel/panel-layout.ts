import { COLOR, FONT_PX } from './tokens.ts'

export const PANEL_LAYOUT_CSS = `
.ops-panel-viewport {
  display: flex; flex: 1 1 auto; flex-direction: column;
  block-size: 100dvh; max-block-size: 100%; min-block-size: 0; min-inline-size: 0;
  container-type: inline-size; container-name: orchestra-panel;
}
.ops-shell { display: flex; flex: 1; min-height: 0; min-width: 0; }
.ops-shell-sidebar {
  box-sizing: border-box; flex: none; width: 236px; min-height: 0; min-width: 0;
  padding: 22px 14px; overflow: auto; scrollbar-gutter: stable;
  border-right: 1px solid ${COLOR.line};
}
.ops-shell-brand { padding: 4px 10px 22px; }
.ops-shell-sidebar nav { display: grid; gap: 4px; }
.ops-shell-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.ops-shell-main > header, .ops-shell-main > [role=status] { flex: none; }
.ops-shell-main > main {
  flex: 1; min-width: 0; min-height: 0; overflow: auto;
  scrollbar-gutter: stable; overscroll-behavior: contain;
}
.ops-shell-main > main:focus-visible { outline: 2px solid #225fba; outline-offset: -2px; }
.ops-panel-content-inner { box-sizing: border-box; max-width: 1780px; margin-inline: auto; }
.ops-panel-protocol-error {
  flex: 1; min-height: 0; overflow: auto; display: grid;
  align-content: safe center; justify-content: safe center;
  padding: 24px; text-align: center; overflow-wrap: anywhere;
}
.ops-page { display: grid; align-content: start; gap: 12px; min-width: 0; }
.ops-page-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px 14px; min-width: 0; }
.ops-page h1 { margin: 0; font-size: ${FONT_PX.title}px; line-height: 1.3; letter-spacing: -.02em; overflow-wrap: anywhere; }
.ops-page h2 { font-size: ${FONT_PX.section}px; line-height: 1.4; }
.ops-meta { color: #546275; font-size: ${FONT_PX.menu}px; margin: 4px 0 0; }
.ops-page button, .ops-page input, .ops-page select, .ops-page textarea { font-family: inherit; }
.ops-actions, .ops-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.ops-toolbar { justify-content: space-between; }
.ops-button, .ops-field { box-sizing: border-box; min-height: 34px; border: 1px solid #d8e0ea; border-radius: 7px; color: #1d2939; background: #fff; font: inherit; font-size: ${FONT_PX.menu}px; }
.ops-field { padding: 5px 9px; max-width: 100%; min-width: 0; }
.ops-button { padding: 5px 11px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.ops-button:hover:not(:disabled) { background: #f0f5fb; }
.ops-button:disabled { color: #64748b; background: #f8fafc; cursor: default; }
.ops-button--primary { color: #fff; background: #225fba; border-color: #225fba; }
.ops-button--primary:hover:not(:disabled) { background: #174c9a; }
.ops-button--link { color: #2057a1; border-color: transparent; background: transparent; }
.ops-surface { min-width: 0; border: 1px solid #dde4ed; border-radius: 9px; background: #fff; }
.ops-surface-head { display: flex; justify-content: space-between; align-items: center; gap: 7px; padding: 9px 12px; background: #f8fafc; border-bottom: 1px solid #e3e9f0; border-radius: 8px 8px 0 0; }
.ops-surface-head h2 { margin: 0; }
.ops-table-scroll { min-width: 0; overflow-x: auto; }
.ops-table { width: 100%; border-collapse: collapse; text-align: left; font-size: ${FONT_PX.menu}px; }
.ops-table--wide { min-width: 640px; }
.ops-table th, .ops-table td { vertical-align: middle; padding: 8px 12px; }
.ops-table th { color: #526274; font-weight: 600; white-space: nowrap; background: #f4f7fb; }
.ops-table td { border-top: 1px solid #e8edf3; }
.ops-table tbody tr:hover { background: #f8fbff; }
.ops-table td:first-child { overflow-wrap: anywhere; }
.ops-table time, .ops-number { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ops-status { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border: 1px solid #dce3eb; border-radius: 5px; font-size: ${FONT_PX.helper}px; line-height: 1.45; font-weight: 600; background: #f2f5f8; color: #45546a; white-space: nowrap; }
.ops-status[data-tone=on] { color: #146048; background: #eaf5ef; border-color: #cce7da; }
.ops-status[data-tone=off] { color: #46546a; background: #f0f3f8; border-color: #dce3eb; }
.ops-status[data-tone=info] { color: #23569e; background: #edf4ff; border-color: #d8e6fa; }
.ops-empty { margin: 0; padding: 14px 12px; color: #546275; }
.ops-tabs { display: flex; flex-wrap: wrap; gap: 5px; align-items: flex-end; border-bottom: 1px solid #dbe3ed; }
.ops-tabs button { color: #526274; font: inherit; font-weight: 550; min-height: 36px; border: 0; border-bottom: 2px solid transparent; background: none; padding: 5px 10px; cursor: pointer; }
.ops-tabs [aria-pressed=true] { color: #1e55a1; border-bottom-color: #225fba; }
.ops-stack { display: grid; gap: 10px; min-width: 0; align-content: start; }
.ops-context-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); align-items: start; gap: 10px; }
.ops-settings-page { width: 100%; max-width: 1100px; margin-inline: auto; }
.ops-settings-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.ops-settings-section fieldset { min-width: 0; }
.ops-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(400px, 100%), 1fr)); align-items: start; gap: 10px; }
.ops-card-grid:empty { display: none; }
.ops-inset { padding: 10px 12px; }
.ops-inset > details + details { border-top: 1px solid #e8edf3; margin-top: 6px; padding-top: 6px; }
.ops-entry-form { display: grid; gap: 7px; padding: 10px 12px; justify-items: start; }
.ops-entry-form textarea { width: min(100%, 660px); }
.ops-entry-form label { font-weight: 600; }
.ops-page details > summary { cursor: pointer; }
.ops-workflow-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(205px, 26%); min-width: 0; align-items: stretch; gap: 8px; }
.ops-workflow-stage aside p { margin: 3px 0; overflow-wrap: anywhere; }
.ops-workflow-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(255px, 100%), 1fr)); gap: 8px; }
.ops-workflow-controls > section { padding: 9px 11px; min-width: 0; background: #f7f9fc; border: 1px solid #e1e7ef; border-radius: 7px; }
.ops-workflow-controls > section > :first-child { margin-top: 0; }
.ops-workflow-controls ol, .ops-workflow-controls ul { padding-left: 20px; }
.ops-shell-main:not([data-panel-route=tasks]) { background: #f4f7fb; }
.ops-shell-main[data-panel-route=tasks] .ops-panel-content-inner { padding: 28px 32px 80px; }
.ops-shell-main:not([data-panel-route=tasks]) .ops-panel-content-inner { padding: 16px 22px 36px; }
@container orchestra-panel (max-width: 980px) {
  .ops-shell-sidebar { width: 164px; padding: 11px 8px; }
}
@container orchestra-panel (max-width: 680px) {
  .ops-shell { flex-direction: column; }
  .ops-shell-sidebar { width: 100%; padding: 5px 8px; border-right: 0; overflow: visible; scrollbar-gutter: auto; }
  .ops-shell-brand { padding: 4px; }
  .ops-shell-sidebar nav { display: flex; overflow-x: auto; }
  .ops-shell-sidebar nav button { white-space: nowrap; }
  .ops-shell-main[data-panel-route] .ops-panel-content-inner { padding: 10px 10px 24px; }
  .ops-workflow-stage { grid-template-columns: minmax(0, 1fr); }
  .ops-table th, .ops-table td { padding: 7px 8px; }
}
`
