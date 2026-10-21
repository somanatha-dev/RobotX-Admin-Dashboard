import React, { useCallback, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { WifiOff, X } from 'lucide-react';

import AuthChallengeModal from '@/components/modals/AuthChallengeModal.jsx';
import CreateTaskModal from '@/components/modals/CreateTaskModal.jsx';
import DecisionRequiredModal from '@/components/modals/DecisionRequiredModal.jsx';
import { connectionBanner } from '@/lib/connectionState.js';
import { isWideLayout, subscribeWideLayout } from '@/lib/viewport.js';

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
    setIsSidebarOpen,
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

  // Below `lg` the sidebar is a drawer over the page: picking a page closes it, and so do the
  // backdrop and Escape. On a wide screen it sits beside the content and stays as it is.
  const { pathname } = useLocation();
  const closeDrawer = useCallback(() => {
    if (!isWideLayout()) setIsSidebarOpen(false);
  }, [setIsSidebarOpen]);
  useEffect(() => {
    closeDrawer();
  }, [pathname, closeDrawer]);
  // Crossing the breakpoint (a resized window, a rotated tablet) gives the state that width
  // starts with: beside the content when wide, a closed drawer when narrow — not a drawer left
  // open over the page.
  useEffect(() => subscribeWideLayout(setIsSidebarOpen), [setIsSidebarOpen]);
  useEffect(() => {
    if (!isSidebarOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isSidebarOpen, closeDrawer]);

  return (
    // `dvh`, not `vh`: on a phone `100vh` is the height with the browser's toolbars hidden, so
    // the bottom of every page sat underneath them.
    <div className="flex h-dvh bg-muted/40 text-foreground overflow-hidden">
      {/* Sidebar */}
      <AppSidebar />

      {/* Backdrop (mobile) */}
      {isSidebarOpen && (
        <div
          aria-hidden="true"
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 bg-foreground/40 backdrop-blur-sm z-30 lg:hidden"
        />
      )}

      {/* Main Content */}
      <main
        className={`flex-1 min-w-0 overflow-auto overscroll-contain flex flex-col transition-[padding] duration-300 ease-in-out ${
          isSidebarOpen ? 'lg:pl-64' : 'lg:pl-0'
        }`}
      >
        <AppTopBar />
        {/* A flex column, so the page below takes exactly the height that is left: a page that
            fills the screen (the map) fills it without a stray scroll, and a longer page
            grows and scrolls `main`. */}
        <div className="flex-1 flex flex-col px-3 pt-3 pb-4 sm:px-6 sm:py-5">
          {liveBanner && (
            <div
              role="status"
              aria-live="polite"
              data-connection-state={connection.state}
              className={`mb-3 sm:mb-0 sm:mt-2 flex items-start gap-3 rounded-xl border px-4 py-3 ${
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
              className={`mb-3 sm:mb-0 sm:mt-2 flex items-start justify-between gap-3 rounded-xl border px-4 py-3 ${
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
          <div className="flex-1 flex flex-col sm:mt-6 *:flex-1">
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
