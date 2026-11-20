export const TASK_VIEWS = [
  { id: 'board', label: '看板' }, { id: 'flow', label: '流程' },
  { id: 'queue', label: '队列' }, { id: 'list', label: '列表' },
] as const

export const EVENT_PAGE_SIZES = [5, 10, 20] as const
export type TaskView = (typeof TASK_VIEWS)[number]['id']
type DisplayPreferences = Readonly<{
  taskView: TaskView
  eventPageSize: (typeof EVENT_PAGE_SIZES)[number]
}>
type PreferenceState = { preferences: DisplayPreferences; persistent: boolean }

export const DISPLAY_PREFERENCES_KEY = 'dsh-orchestra:display-preferences'
const defaults: DisplayPreferences = { taskView: 'board', eventPageSize: 5 }
const listeners = new Set<() => void>()
let state: PreferenceState = { preferences: defaults, persistent: true }
let pendingLocalChange = false

function decode(stored: string | null): DisplayPreferences {
  try {
    const value = JSON.parse(stored ?? 'null')
    return {
      taskView: TASK_VIEWS.find(({ id }) => id === value?.taskView)?.id ?? defaults.taskView,
      eventPageSize: EVENT_PAGE_SIZES.find((size) =>
        size === value?.eventPageSize || String(size) === value?.eventPageSize) ?? defaults.eventPageSize,
    }
  } catch {
    return defaults
  }
}

export function readDisplayPreferences(): PreferenceState {
  if (typeof window === 'undefined' || pendingLocalChange) return state
  try {
    state = { preferences: decode(window.localStorage.getItem(DISPLAY_PREFERENCES_KEY)), persistent: true }
  } catch {
    state = { ...state, persistent: false }
  }
  return state
}

function save(preferences: DisplayPreferences) {
  try {
    window.localStorage.setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify(preferences))
    pendingLocalChange = false
  } catch {
    pendingLocalChange = true
  }
  state = { preferences, persistent: !pendingLocalChange }
  for (const notify of listeners) notify()
}

export function updateDisplayPreferences(next: Partial<DisplayPreferences>) {
  save({ ...readDisplayPreferences().preferences, ...next })
}

export function resetDisplayPreferences() {
  save(defaults)
}

export function subscribeDisplayPreferences(notify: () => void) {
  listeners.add(notify)
  function onStorage(event: StorageEvent) {
    if (event.key !== DISPLAY_PREFERENCES_KEY && event.key !== null) return
    // Keep unsaved local changes when the browser has refused a write in this tab.
    notify()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(notify)
    window.removeEventListener('storage', onStorage)
  }
}
