import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { useUser, setConfig, Page, Subscribe } from '@kesi/client';
import App from './App';
import './index.css';

const { loadUser } = useUser();
loadUser();
setConfig({
  projectId: 'kesi'
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <Page>
        <Subscribe>
          <App />
        </Subscribe>
      </Page>
    </HashRouter>
  </StrictMode>
);
