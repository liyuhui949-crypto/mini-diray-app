import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './app/App'
import { SyncWindow } from './sync/SyncWindow'

import './styles/index.scss'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 节点')

const isSyncWindow = new URLSearchParams(window.location.search).get('window') === 'sync'

createRoot(container).render(
  <StrictMode>{isSyncWindow ? <SyncWindow /> : <App />}</StrictMode>
)
