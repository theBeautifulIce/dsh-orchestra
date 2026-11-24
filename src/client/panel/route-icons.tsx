import type { PanelRoute } from './shell.tsx'

/** Decorative navigation marks: labels remain the accessible name of every route. */
export function RouteIcon({ route }: { route: PanelRoute }) {
  const paths = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    tasks: <><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M9 3h6v3H9zM8 11l1 1 2-2m3 1h3M8 16l1 1 2-2m3 1h3" /></>,
    decisions: <><path d="M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6l-8-3Z" /><path d="m8.5 11.5 2.5 2.5 4.5-5" /></>,
    effects: <><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5m-13-10 2 2 4-4" /></>,
    workflows: <><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v6a3 3 0 0 0 3 3h6" /></>,
    activity: <><path d="M4 3h16v18H4zM8 7h8M8 12h8M8 17h5" /></>,
    collaboration: <><circle cx="7" cy="7" r="3" /><circle cx="17" cy="7" r="3" /><path d="M2 20v-2a5 5 0 0 1 8-4m12 6v-2a5 5 0 0 0-8-4m-4 4h4m-2-2 2 2-2 2" /></>,
    memory: <><path d="M4 4h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v16h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4V4Zm8 1v16" /><path d="M7 8h2m6 0h2M7 12h2m6 0h2" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none" /></>,
  }
  return <svg className="ops-route-icon" viewBox="0 0 24 24" width="19" height="19" fill="none"
    stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {paths[route]}
  </svg>
}
