import React, { useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { WifiOff, X } from 'lucide-react';

import AuthChallengeModal from '@/components/modals/AuthChallengeModal.jsx';
import CreateTaskModal from '@/components/modals/CreateTaskModal.jsx';
import DecisionRequiredModal from '@/components/modals/DecisionRequiredModal.jsx';
import { connectionBanner } from '@/lib/connectionState.js';

import AppSidebar from '@/components/layout/AppSidebar.jsx';
import AppTopBar from '@/components/layout/AppTopBar.jsx';
import { useAppActions, useAppState } from '@/context/appContext.js';

export default function Layout() {
  const {
    isSidebarOpen,
    authRequest,
    isCreatingTask,
    decisionRequest,
    notice,
    connection,
  } = useAppState();

  const {
    setAuthRequest,
    setIsCreatingTask,
    createTask,
    setDecisionRequest,
    dismissNotice,
  } = useAppActions();

  // FS-06 — the obstacle alert is information: closing it is all the operator can do, and
  // it sends nothing. (There used to be WAIT, a REROUTE that called the legacy
  // `/tasks/:id/reroute` outside the engine, and a CANCEL that logged "continues current
  // route" — a claim about the robot this page cannot make.)
  const handleDismissAlert = useCallback(() => setDecisionRequest(null), [setDecisionRequest]);

  // FS-02 — the page's live data stops being live with the socket; say so on every page.
  const liveBanner = connectionBanner(connection?.state, connection?.lastLiveAtMs);

  return (
    <div className="flex h-screen bg-muted/40 text-foreground overflow-hidden">
      {/* Sidebar */}
      <AppSidebar />

      {/* Backdrop (mobile) */}
      {isSidebarOpen && <div className="fixed inset-0 bg-foreground/40 backdrop-blur-sm z-30 lg:hidden" />}

      {/* Main Content */}
      <main
        className={`flex-1 min-w-0 overflow-auto flex flex-col transition-[padding] duration-300 ease-in-out ${
          isSidebarOpen ? 'lg:pl-64' : 'lg:pl-0'
        }`}
      >
        <AppTopBar />
        <div className="flex-1 min-h-0 px-6 py-5">
          {liveBanner && (
            <div
              role="status"
              aria-live="polite"
              data-connection-state={connection.state}
              className={`mt-2 flex items-start gap-3 rounded-xl border px-4 py-3 ${
                liveBanner.kind === 'warning'
                  ? 'border-rose-300 bg-rose-50 text-rose-900'
                  : 'border-slate-200 bg-white text-slate-700'
              }`}
            >
              <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold">{liveBanner.title}</div>
                <div className="mt-0.5 text-xs">{liveBanner.message}</div>
              </div>
            </div>
          )}
          {notice && (
            <div
              role="status"
              data-operator-notice={notice.kind || 'info'}
              className={`mt-2 flex items-start justify-between gap-3 rounded-xl border px-4 py-3 ${
                notice.kind === 'warning'
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-slate-200 bg-white text-slate-800'
              }`}
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold">{notice.title}</div>
                {notice.message ? <div className="mt-0.5 text-xs">{notice.message}</div> : null}
              </div>
              <button
                type="button"
                onClick={dismissNotice}
                aria-label="Dismiss notice"
                className="shrink-0 rounded-md p-1 text-current opacity-70 hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className="mt-6 h-full min-h-0">
            <Outlet />
          </div>
        </div>
      </main>

      {authRequest && <AuthChallengeModal request={authRequest} onClose={() => setAuthRequest(null)} />}

      {isCreatingTask && (
        <CreateTaskModal onClose={() => setIsCreatingTask(false)} onCreate={createTask} />
      )}

      {decisionRequest && !authRequest && (
        <DecisionRequiredModal decisionRequest={decisionRequest} onDismiss={handleDismissAlert} />
      )}
    </div>
  );
}
