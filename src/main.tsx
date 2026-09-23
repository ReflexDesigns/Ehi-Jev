import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// Entry point dell'interfaccia "The Notch".
// Nota: niente StrictMode per evitare la doppia sottoscrizione
// agli eventi Tauri durante lo sviluppo.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <App />,
);
