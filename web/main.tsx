import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles/tokens.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, initialTheme } from './App.tsx';
import { HttpBackend } from './backend/http.ts';
import { createStore } from './state.ts';

// Set the theme before the first paint.
document.documentElement.dataset.theme = initialTheme();

async function start(): Promise<void> {
  // ?mock=1 runs the whole product in this tab: same engine, PayPal simulator, scripted planner, no backend.
  const mock = new URLSearchParams(location.search).get('mock') === '1';
  const backend = mock ? new (await import('./backend/mock.ts')).MockBackend() : new HttpBackend();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App backend={backend} store={createStore()} />
    </StrictMode>,
  );
}

void start();
