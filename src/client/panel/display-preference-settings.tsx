import { useEffect, useState } from 'react'
import {
  EVENT_PAGE_SIZES, TASK_VIEWS, readDisplayPreferences, resetDisplayPreferences,
  subscribeDisplayPreferences, updateDisplayPreferences,
} from './display-preferences.ts'

export function DisplayPreferenceSettings() {
  const [{ preferences, persistent }, setState] = useState(readDisplayPreferences)
  useEffect(() => {
    const refresh = () => setState(readDisplayPreferences())
    const unsubscribe = subscribeDisplayPreferences(refresh)
    refresh()
    return unsubscribe
  }, [])

  return <section className="ops-surface" aria-label="显示偏好">
    <header className="ops-surface-head">
      <h2 id="display-preferences-title" tabIndex={-1} className="ops-settings-anchor">显示偏好</h2>
      <button type="button" className="ops-button" onClick={resetDisplayPreferences}>恢复显示默认值</button>
    </header>
    <div className="ops-inset">
      <p>偏好保存在当前浏览器，同一地址下的面板共用。下次打开任务页或事件页时生效。</p>
      {!persistent && <p role="status">浏览器存储不可用，本次更改仅保留在当前页面。</p>}
      <div style={fieldsStyle}>
        <label style={fieldStyle}>任务默认视图
          <select className="ops-field" value={preferences.taskView} onChange={(event) => {
            const view = TASK_VIEWS.find(({ id }) => id === event.target.value)
            if (view) updateDisplayPreferences({ taskView: view.id })
          }}>
            {TASK_VIEWS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>任务与运行事件每页条数
          <select className="ops-field" value={preferences.eventPageSize} onChange={(event) => {
            const size = EVENT_PAGE_SIZES.find((size) => String(size) === event.target.value)
            if (size !== undefined) updateDisplayPreferences({ eventPageSize: size })
          }}>
            {EVENT_PAGE_SIZES.map((size) => <option key={size} value={size}>{size} 条</option>)}
          </select>
        </label>
      </div>
    </div>
  </section>
}

const fieldsStyle = { display: 'flex', flexWrap: 'wrap', gap: 16 } as const
const fieldStyle = { display: 'grid', gap: 4 } as const
