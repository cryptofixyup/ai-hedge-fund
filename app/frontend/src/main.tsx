import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { AuthGate } from './components/auth/auth-gate';
import { NodeProvider } from './contexts/node-context';
import { ThemeProvider } from './providers/theme-provider';

import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <ThemeProvider>
        <NodeProvider>
          <App />
        </NodeProvider>
      </ThemeProvider>
    </AuthGate>
  </React.StrictMode>
);
