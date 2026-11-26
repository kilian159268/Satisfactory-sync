import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-ext-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-ext-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist/latin-ext-600.css';
import './styles.css';
import { App } from './App';

const root = document.getElementById('root');
if (root === null) throw new Error('#root fehlt in index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
