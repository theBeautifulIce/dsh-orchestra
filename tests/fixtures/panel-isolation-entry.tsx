import { createRoot } from 'react-dom/client'
import { createPanelHost } from '../../src/client/panel-host.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('没有面板容器')
const Panel = createPanelHost({ baseUrl: location.origin, panelVersion: 'Q-22' })
createRoot(root).render(<Panel />)
