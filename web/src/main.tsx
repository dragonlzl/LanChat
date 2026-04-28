import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { getMe, setPortalAuthFailureHandler, setPortalJwtToken } from './api';
import App from './App';
import { clearPortalJwtSession, requirePortalJwtSession, resetPortalLoginGuard } from './portal-auth';
import './styles.css';

let portalAuthRecoveryStarted = false;

setPortalAuthFailureHandler(() => {
  if (portalAuthRecoveryStarted) {
    return;
  }

  portalAuthRecoveryStarted = true;
  setPortalJwtToken(null);
  resetPortalLoginGuard();
  void clearPortalJwtSession().finally(() => {
    window.location.reload();
  });
});

function AuthGate() {
  const [state, setState] = React.useState<
    | { status: 'checking' }
    | { status: 'ready' }
    | { status: 'error'; message: string }
  >({ status: 'checking' });

  React.useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const session = await requirePortalJwtSession();
        setPortalJwtToken(session.token);
        await getMe();
        if (!cancelled) {
          setState({ status: 'ready' });
        }
      } catch (error) {
        setPortalJwtToken(null);
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'JWT 登录或校验失败',
          });
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'checking') {
    return (
      <div className="app-shell">
        <div className="empty-state full-page">登录检测中…</div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="app-shell">
        <div className="panel-card error-layout">
          <h2>JWT 登录失败</h2>
          <p>{state.message}</p>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              resetPortalLoginGuard();
              void clearPortalJwtSession().finally(() => window.location.reload());
            }}
          >
            重新登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <HashRouter>
      <App />
    </HashRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>,
);
