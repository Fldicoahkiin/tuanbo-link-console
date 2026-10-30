// First stylesheet: declares the cascade layers before any component brings its own styles.
import './styles/layers.css';
import './styles/tokens.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { LinkApp } from './link/LinkApp';
import { LicenseGate } from './link/components/LicenseGate';
import { installRendererErrorLog } from './link/runtime/renderer-error-log';
import './link/link.css';
import './link/project-workspace.css';
import './link/appearance.css';
import './link/home-layout.css';
import './link/settings-content.css';
import './link/lighting.css';
import './link/properties.css';
import './link/device-connections.css';
import './link/timeline-editing.css';
import './link/interface.css';

installRendererErrorLog();
const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <LicenseGate><LinkApp /></LicenseGate>
  </React.StrictMode>
);
