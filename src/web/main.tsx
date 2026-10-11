import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './styles.css';

// A click never moves the keyboard focus to a button or link, so Space and Enter keep reaching
// the shortcuts instead of pressing what was clicked last. Tab still focuses them.
document.addEventListener(
  'mousedown',
  (event) => {
    if (event.target instanceof Element && event.target.closest('button, a[href]')) {
      event.preventDefault();
    }
  },
  { capture: true },
);

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
