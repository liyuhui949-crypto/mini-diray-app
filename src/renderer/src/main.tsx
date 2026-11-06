import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './app/App'

import './styles/index.scss'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 节点')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
