import { COLOR, FONT_PX } from './tokens.ts'

// Every selector is scoped to the embedded panel; the DSH host owns the page outside it.
export const PANEL_LAYOUT_CSS = `
.ops-panel-viewport {
  position: relative; display: flex; flex: 1 1 auto; flex-direction: column;
  block-size: 100dvh; max-block-size: 100%; min-block-size: 0; min-inline-size: 0;
  container-type: inline-size; container-name: orchestra-panel;
}
.ops-panel-viewport .ops-skip-link {
  position: absolute; z-index: 10; inset: 8px auto auto 8px; transform: translateY(-160%);
  min-height: 44px; padding: 8px 16px; border: 1px solid ${COLOR.link}; border-radius: 8px;
  background: ${COLOR.surface}; color: ${COLOR.link}; font: inherit; opacity: 0; pointer-events: none;
}
.ops-panel-viewport .ops-skip-link:focus { transform: translateY(0); opacity: 1; pointer-events: auto; }
.ops-panel-viewport :is(button, a, input, select, textarea, summary):focus-visible {
  outline: 2px solid ${COLOR.link}; outline-offset: 3px;
}
.ops-panel-viewport .ops-shell { display: flex; flex: 1; min-height: 0; min-width: 0; }
.ops-panel-viewport .ops-shell-sidebar {
  box-sizing: border-box; flex: none; width: 214px; min-height: 0; min-width: 0;
  padding: 26px 12px 20px; overflow: auto; scrollbar-gutter: stable;
  background: ${COLOR.sidebar}; border-right: 1px solid ${COLOR.line};
}
.ops-panel-viewport .ops-shell-identity { padding: 0 12px 18px; }
.ops-panel-viewport .ops-shell-brand {
  display: flex; align-items: baseline; gap: 4px; font-size: ${FONT_PX.brand}px;
  line-height: 1.4; letter-spacing: -.04em; font-weight: 750;
}
.ops-panel-viewport .ops-shell-brand > span { width: 5px; height: 5px; border-radius: 50%; background: ${COLOR.link}; }
.ops-panel-viewport .ops-shell-caption { margin: 6px 0 0; font-size: ${FONT_PX.helper}px; color: ${COLOR.inkMuted}; }
.ops-panel-viewport .ops-main-menu { display: grid; gap: 14px; }
.ops-panel-viewport .ops-nav-group { display: grid; gap: 3px; }
.ops-panel-viewport .ops-nav-group-label { padding: 0 12px 5px; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.helper}px; }
.ops-panel-viewport .ops-nav-button {
  display: flex; align-items: center; gap: 10px; min-height: 44px; min-width: 0;
  padding: 9px 12px; border: 0; border-radius: 8px; text-align: start;
  background: transparent; color: ${COLOR.inkMuted}; font: inherit; font-size: ${FONT_PX.body}px;
  font-weight: 500; cursor: pointer;
}
.ops-panel-viewport .ops-nav-button:hover { background: #eef1f6; color: ${COLOR.ink}; }
.ops-panel-viewport .ops-nav-button[aria-current=page] { color: ${COLOR.link}; background: ${COLOR.selected}; font-weight: 650; }
.ops-panel-viewport .ops-route-icon { flex: none; }
.ops-panel-viewport .ops-settings-menu {
  display: grid; gap: 2px; margin: 4px 0 0 21px; padding-inline-start: 8px;
  border-inline-start: 1px solid ${COLOR.line};
}
.ops-panel-viewport .ops-settings-menu button {
  min-height: 44px; border: 0; border-radius: 6px; padding: 5px 8px;
  background: transparent; color: ${COLOR.inkMuted}; text-align: start;
  font: inherit; font-size: ${FONT_PX.menu}px; cursor: pointer;
}
.ops-panel-viewport .ops-settings-menu button:hover { background: #eef1f6; }
.ops-panel-viewport .ops-settings-menu button[aria-current=location] { background: ${COLOR.selected}; color: ${COLOR.link}; font-weight: 650; }
.ops-panel-viewport .ops-settings-anchor:focus-visible { outline: 2px solid ${COLOR.link}; outline-offset: 3px; }
.ops-panel-viewport .ops-shell-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; background: ${COLOR.canvas}; }
.ops-panel-viewport .ops-shell-main > header, .ops-panel-viewport .ops-shell-main > [role=status] { flex: none; }
.ops-panel-viewport .ops-shell-header {
  box-sizing: border-box; min-height: 69px; padding: 12px 32px; display: flex; align-items: center;
  justify-content: space-between; gap: 12px; border-bottom: 1px solid ${COLOR.line};
  font-size: ${FONT_PX.menu}px; background: ${COLOR.surface};
}
.ops-panel-viewport .ops-breadcrumb { display: flex; align-items: center; gap: 12px; min-width: 0; color: ${COLOR.inkMuted}; }
.ops-panel-viewport .ops-breadcrumb strong { color: ${COLOR.ink}; font-weight: 550; overflow-wrap: anywhere; }
.ops-panel-viewport .ops-breadcrumb > span { flex: none; }
.ops-panel-viewport .ops-connection-state {
  display: inline-flex; align-items: center; gap: 7px; flex: none; border-radius: 6px;
  padding: 5px 9px; font-size: ${FONT_PX.helper}px; white-space: nowrap;
}
.ops-panel-viewport .ops-connection-state[data-tone=success] { color: ${COLOR.success}; background: #edf7f0; }
.ops-panel-viewport .ops-connection-state[data-tone=warning] { color: ${COLOR.warning}; background: #fff5e2; }
.ops-panel-viewport .ops-connection-state[data-tone=info] { color: ${COLOR.link}; background: ${COLOR.selected}; }
.ops-panel-viewport .ops-state-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: currentColor; }
.ops-panel-viewport .ops-connection-notice {
  padding: 11px 32px; background: #fff8e9; color: ${COLOR.warning};
  border-bottom: 1px solid ${COLOR.line}; font-size: ${FONT_PX.menu}px;
}
.ops-panel-viewport .ops-shell-main > main {
  flex: 1; min-width: 0; min-height: 0; overflow: auto;
  scrollbar-gutter: stable; overscroll-behavior: contain;
}
.ops-panel-viewport .ops-shell-main > main:focus-visible { outline: 2px solid ${COLOR.link}; outline-offset: -2px; }
.ops-panel-viewport .ops-panel-content-inner { box-sizing: border-box; width: 100%; max-width: 1600px; margin-inline: auto; padding: 30px 32px 48px; }
.ops-panel-viewport .ops-panel-protocol-error {
  flex: 1; min-height: 0; overflow: auto; display: grid;
  align-content: safe center; justify-content: safe center;
  padding: 24px; text-align: center; overflow-wrap: anywhere;
}
.ops-panel-viewport .ops-page { display: grid; align-content: start; gap: 20px; min-width: 0; }
.ops-panel-viewport .ops-page-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px 18px; min-width: 0; }
.ops-panel-viewport .ops-page h1 { margin: 0; font-size: ${FONT_PX.title}px; line-height: 1.35; letter-spacing: -.025em; overflow-wrap: anywhere; }
.ops-panel-viewport .ops-page h2 { font-size: ${FONT_PX.section}px; line-height: 1.5; }
.ops-panel-viewport .ops-meta { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; margin: 6px 0 0; line-height: 1.65; }
.ops-panel-viewport .ops-page button, .ops-panel-viewport .ops-page input,
.ops-panel-viewport .ops-page select, .ops-panel-viewport .ops-page textarea { font-family: inherit; }
.ops-panel-viewport .ops-actions, .ops-panel-viewport .ops-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ops-panel-viewport .ops-toolbar { justify-content: space-between; }
/* Low-specificity safety net for new raw controls in the workbench. Explicit
   component classes and scoped layout rules retain priority. Do not alter
   native checkboxes, radios, file inputs, range inputs or hidden fields. */
.ops-panel-viewport :where(button:not([class]):not([style]), textarea:not([class]):not([style]), select:not([class]):not([style]), input:not([class]):not([style]):is(:not([type]), [type=text], [type=number], [type=search], [type=date], [type=time], [type=email], [type=password], [type=url], [type=tel])) {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: 44px; border: 1px solid ${COLOR.line};
  border-radius: 8px; color: ${COLOR.ink}; background: ${COLOR.surface}; font: inherit; font-size: ${FONT_PX.body}px; padding: 9px 12px;
}
.ops-panel-viewport :where(button:not([class]):not([style])) { cursor: pointer; font-weight: 550; }
.ops-panel-viewport :where(button:not([class]):not([style]):disabled) { color: ${COLOR.inkMuted}; background: ${COLOR.sidebar}; cursor: not-allowed; }
.ops-panel-viewport :where(button:not([class]):not([style]):focus-visible, textarea:not([class]):not([style]):focus-visible, select:not([class]):not([style]):focus-visible) { outline: 2px solid ${COLOR.link}; outline-offset: 2px; }
.ops-panel-viewport .ops-button, .ops-panel-viewport .ops-field {
  box-sizing: border-box; min-height: 44px; border: 1px solid ${COLOR.line}; border-radius: 8px;
  color: ${COLOR.ink}; background: ${COLOR.surface}; font: inherit; font-size: ${FONT_PX.body}px;
}
.ops-panel-viewport .ops-field { padding: 9px 12px; max-width: 100%; min-width: 0; }
.ops-panel-viewport .ops-button { padding: 9px 14px; font-weight: 550; cursor: pointer; white-space: nowrap; }
.ops-panel-viewport .ops-button:hover:not(:disabled) { background: #f3f5f8; }
.ops-panel-viewport .ops-button:disabled { color: ${COLOR.inkMuted}; background: #f8fafc; cursor: not-allowed; }
.ops-panel-viewport .ops-button--primary { color: #fff; background: ${COLOR.link}; border-color: ${COLOR.link}; }
.ops-panel-viewport .ops-button--primary:hover:not(:disabled) { background: #194bbc; }
.ops-panel-viewport .ops-button--link { color: ${COLOR.link}; border-color: transparent; background: transparent; }
.ops-panel-viewport .ops-surface { min-width: 0; border: 1px solid ${COLOR.line}; border-radius: 12px; background: ${COLOR.surface}; }
.ops-panel-viewport .ops-surface-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; padding: 18px 20px; border-bottom: 1px solid ${COLOR.line}; border-radius: 11px 11px 0 0; }
.ops-panel-viewport .ops-surface-head h2 { margin: 0; }
.ops-panel-viewport .ops-table-scroll { min-width: 0; overflow-x: auto; }
.ops-panel-viewport .ops-table { width: 100%; border-collapse: collapse; text-align: left; font-size: ${FONT_PX.menu}px; }
.ops-panel-viewport .ops-table--wide { min-width: 640px; }
.ops-panel-viewport .ops-table th, .ops-panel-viewport .ops-table td { vertical-align: middle; padding: 13px 16px; }
.ops-panel-viewport .ops-table th { color: ${COLOR.inkMuted}; font-weight: 550; white-space: nowrap; background: ${COLOR.sidebar}; }
.ops-panel-viewport .ops-table td { border-top: 1px solid ${COLOR.line}; }
.ops-panel-viewport .ops-table tbody tr:hover { background: #fafcff; }
.ops-panel-viewport .ops-table td:first-child { overflow-wrap: anywhere; }
.ops-panel-viewport .ops-table time, .ops-panel-viewport .ops-number { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ops-panel-viewport .ops-status { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border: 1px solid ${COLOR.line}; border-radius: 5px; font-size: ${FONT_PX.helper}px; line-height: 1.45; font-weight: 550; background: #f2f5f8; color: ${COLOR.inkMuted}; white-space: nowrap; }
.ops-panel-viewport .ops-status[data-tone=on] { color: ${COLOR.success}; background: #edf7f0; border-color: #d6eadf; }
.ops-panel-viewport .ops-status[data-tone=off] { color: ${COLOR.inkMuted}; background: #f0f3f8; border-color: ${COLOR.line}; }
.ops-panel-viewport .ops-status[data-tone=info] { color: ${COLOR.link}; background: ${COLOR.selected}; border-color: #d8e6fa; }
.ops-panel-viewport .ops-empty { margin: 0; padding: 24px 20px; color: ${COLOR.inkMuted}; line-height: 1.7; }
.ops-panel-viewport .ops-tabs { display: flex; flex-wrap: wrap; gap: 5px; align-items: flex-end; border-bottom: 1px solid ${COLOR.line}; }
.ops-panel-viewport .ops-tabs button { color: ${COLOR.inkMuted}; font: inherit; font-weight: 550; min-height: 44px; border: 0; border-bottom: 2px solid transparent; background: none; padding: 9px 13px; cursor: pointer; }
.ops-panel-viewport .ops-tabs [aria-pressed=true] { color: ${COLOR.link}; border-bottom-color: ${COLOR.link}; }
.ops-panel-viewport .ops-stack { display: grid; gap: 16px; min-width: 0; align-content: start; }
.ops-panel-viewport .ops-decision-card { container: decision-card / inline-size; overflow-wrap: anywhere; }
.ops-panel-viewport .ops-decision-summary { margin: 14px 0 10px; font-size: ${FONT_PX.body}px; line-height: 1.7; }
.ops-panel-viewport .ops-decision-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 16px; margin: 0; font-size: ${FONT_PX.body}px; line-height: 1.7; }
.ops-panel-viewport .ops-decision-details dt { color: ${COLOR.inkMuted}; }
.ops-panel-viewport .ops-decision-details dd { margin: 0; min-width: 0; }
.ops-panel-viewport .ops-decision-evidence { display: block; margin-top: 4px; }
.ops-panel-viewport .ops-decision-handling { display: grid; gap: 14px; margin-top: 18px; padding-top: 16px; border-top: 1px solid ${COLOR.line}; }
.ops-panel-viewport .ops-decision-handling .ops-meta { margin: 0; }
.ops-panel-viewport .ops-decision-options { display: grid; gap: 12px; }
.ops-panel-viewport .ops-decision-option { display: grid; gap: 5px; justify-items: start; }
.ops-panel-viewport .ops-decision-option > .ops-button { max-width: 100%; white-space: normal; text-align: left; }
.ops-panel-viewport .ops-decision-option p { margin: 0; color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; line-height: 1.65; }
@container decision-card (max-width: 360px) {
  .ops-panel-viewport .ops-decision-details { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .ops-panel-viewport .ops-decision-details dd { margin-bottom: 8px; }
}
.ops-panel-viewport .ops-context-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); align-items: start; gap: 20px; }
.ops-panel-viewport .ops-settings-page { width: 100%; max-width: 1100px; margin-inline: auto; }
.ops-panel-viewport .ops-settings-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
.ops-panel-viewport .ops-settings-section fieldset { min-width: 0; }
.ops-panel-viewport .ops-setting-body { display: grid; gap: 16px; min-width: 0; container: orchestra-setting / inline-size; }
.ops-panel-viewport .ops-setting-body p { margin: 0; }
.ops-panel-viewport .ops-setting-row {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
  align-items: start; gap: 12px 24px; min-width: 0;
}
.ops-panel-viewport .ops-setting-copy { display: grid; gap: 5px; min-width: 0; }
.ops-panel-viewport .ops-setting-label { font-weight: 650; }
.ops-panel-viewport .ops-setting-control { display: grid; gap: 8px; min-width: 0; }
.ops-panel-viewport .ops-setting-control > .ops-field { width: 100%; }
.ops-panel-viewport .ops-setting-help, .ops-panel-viewport .ops-setting-feedback,
.ops-panel-viewport .ops-setting-note { color: ${COLOR.inkMuted}; font-size: ${FONT_PX.menu}px; line-height: 1.65; overflow-wrap: anywhere; }
.ops-panel-viewport .ops-setting-feedback[role=alert] { color: ${COLOR.danger}; }
.ops-panel-viewport .ops-setting-note { padding-top: 12px; border-top: 1px solid ${COLOR.line}; }
@container orchestra-setting (max-width: 620px) {
  .ops-panel-viewport .ops-setting-row { grid-template-columns: minmax(0, 1fr); gap: 10px; }
}
.ops-panel-viewport .ops-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(400px, 100%), 1fr)); align-items: start; gap: 20px; }
.ops-panel-viewport .ops-card-grid:empty { display: none; }
.ops-panel-viewport .ops-inset { padding: 18px 20px; }
.ops-panel-viewport .ops-inset > details + details { border-top: 1px solid ${COLOR.line}; margin-top: 12px; padding-top: 12px; }
.ops-panel-viewport .ops-entry-form { display: grid; gap: 12px; padding: 18px 20px; justify-items: start; }
.ops-panel-viewport .ops-entry-form textarea { width: min(100%, 660px); }
.ops-panel-viewport .ops-entry-form label { font-weight: 600; }
.ops-panel-viewport .ops-page details > summary { cursor: pointer; }
.ops-panel-viewport .ops-workflow-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(205px, 26%); min-width: 0; align-items: stretch; gap: 16px; }
.ops-panel-viewport .ops-workflow-stage aside p { margin: 3px 0; overflow-wrap: anywhere; }
.ops-panel-viewport .ops-workflow-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(255px, 100%), 1fr)); gap: 16px; }
.ops-panel-viewport .ops-workflow-controls > section { padding: 16px; min-width: 0; background: ${COLOR.sidebar}; border: 1px solid ${COLOR.line}; border-radius: 8px; }
.ops-panel-viewport .ops-workflow-controls > section > :first-child { margin-top: 0; }
.ops-panel-viewport .ops-workflow-controls ol, .ops-panel-viewport .ops-workflow-controls ul { padding-left: 20px; }
@container orchestra-panel (max-width: 980px) {
  .ops-panel-viewport .ops-shell-sidebar { width: 184px; padding-inline: 8px; }
  .ops-panel-viewport .ops-panel-content-inner { padding: 26px 24px 40px; }
  .ops-panel-viewport .ops-shell-header { padding-inline: 24px; }
}
@container orchestra-panel (max-width: 700px) {
  .ops-panel-viewport .ops-shell { flex-direction: column; }
  .ops-panel-viewport .ops-shell-sidebar { width: 100%; padding: 12px 12px 0; border-right: 0; border-bottom: 1px solid ${COLOR.line}; overflow: visible; scrollbar-gutter: auto; background: ${COLOR.surface}; }
  .ops-panel-viewport .ops-shell-identity { padding: 0 4px 9px; }
  .ops-panel-viewport .ops-shell-caption, .ops-panel-viewport .ops-nav-group-label { display: none; }
  .ops-panel-viewport .ops-nav-group { display: contents; }
  .ops-panel-viewport .ops-main-menu { display: flex; gap: 3px; padding-block: 4px 8px; overflow-x: auto; scrollbar-width: thin; }
  .ops-panel-viewport .ops-nav-button { flex: none; padding: 9px 12px; white-space: nowrap; font-size: ${FONT_PX.menu}px; }
  .ops-panel-viewport .ops-nav-button .ops-route-icon { display: none; }
  .ops-panel-viewport .ops-settings-menu {
    display: flex; flex-wrap: nowrap; gap: 4px; margin: 0; padding: 4px 0 8px; overflow-x: auto;
    border-inline-start: 0; border-block-start: 1px solid ${COLOR.line}; scrollbar-width: thin;
  }
  .ops-panel-viewport .ops-settings-menu button { flex: none; white-space: nowrap; }
  .ops-panel-viewport .ops-shell-header { min-height: 56px; padding: 8px 16px; gap: 8px; }
  .ops-panel-viewport .ops-breadcrumb { gap: 8px; font-size: ${FONT_PX.helper}px; }
  .ops-panel-viewport .ops-connection-notice { padding: 10px 16px; }
  .ops-panel-viewport .ops-panel-content-inner { padding: 24px 16px 36px; }
  .ops-panel-viewport .ops-page { gap: 18px; }
  .ops-panel-viewport .ops-page h1 { font-size: ${FONT_PX.titleMobile}px; }
  .ops-panel-viewport .ops-workflow-stage { grid-template-columns: minmax(0, 1fr); }
  .ops-panel-viewport .ops-card-grid, .ops-panel-viewport .ops-context-grid { gap: 16px; }
  .ops-panel-viewport .ops-surface-head, .ops-panel-viewport .ops-inset, .ops-panel-viewport .ops-entry-form { padding: 16px; }
  .ops-panel-viewport .ops-table th, .ops-panel-viewport .ops-table td { padding: 12px; }
}
`
