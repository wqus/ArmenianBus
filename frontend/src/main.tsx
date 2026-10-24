import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/golos-text'
import '@fontsource-variable/cormorant-garamond'
import '@fontsource-variable/noto-serif-armenian'
import '@fontsource-variable/noto-sans-armenian'
import { App } from './app/App'
import './app/styles.css'
import './app/travel.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
