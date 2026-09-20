import './css/index.css';

import { createRoot } from 'react-dom/client';
import App from './components/App';

const containerElement = document.getElementById('container');
if (containerElement) {
  createRoot(containerElement).render(<App />);
}
