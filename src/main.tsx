import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initI18n } from './i18n';
import { useApp } from './state/app';

initI18n('fr'); // French first; the saved language is applied as soon as the local DB is open
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/service-worker.js').catch(() => undefined);
  });
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
useApp.getState().init().then(() => {
  if (useApp.getState().desktop) void import('./state/assistant').then(({ initVoice }) => initVoice());
}).catch(() => undefined);
