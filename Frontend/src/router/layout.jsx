import React, { useCallback, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import { X } from 'lucide-react';

import AuthChallengeModal from '@/components/modals/AuthChallengeModal.jsx';
import CreateTaskModal from '@/components/modals/CreateTaskModal.jsx';
import DecisionRequiredModal from '@/components/modals/DecisionRequiredModal.jsx';
import * as tasksApi from '@/lib/api/tasks.js';

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
  } = useAppState();

  const {
    setAuthRequest,
    setIsCreatingTask,
    createTask,
    requestAuth,
    setDecisionRequest,
    addEvent,
    dismissNotice,
  } = useAppActions();

  // Ref to track the WAIT timer so it can be cleared if a new decision arrives
  const waitTimerRef = useRef(null);

  // WAIT: dismiss the modal now, re-open the same popup in 2 minutes
  const handleWait = useCallback(() => {
    const saved = decisionRequest;
    setDecisionRequest(null);
    if (waitTimerRef.current) clearTimeout(waitTimerRef.current);
    waitTimerRef.current = setTimeout(() => {
      waitTimerRef.current = null;
      setDecisionRequest((prev) => prev ?? { ...saved, countdown: 60 });
    }, 120_000);
    addEvent(`Waiting 2 min before re-prompting for ${saved?.robotId}`, 'info');
  }, [decisionRequest, setDecisionRequest, addEvent]);

  // REROUTE: ask backend to compute a fresh Mapbox route from robot's current position,
  // then dismiss the modal. Wrapped in requestAuth so operator must confirm.
  const handleReroute = useCallback(() => {
    const req = decisionRequest;
    requestAuth('SWARM OVERRIDE: REROUTE', async () => {
      setDecisionRequest(null);
      const taskId = req?.taskId;
      if (taskId) {
        try {
          await tasksApi.rerouteTask(taskId);
          addEvent(`Reroute computed for task ${taskId}`, 'info');
        } catch {
          addEvent(`Reroute failed for task ${taskId}`, 'warning');
        }
      }
    });
  }, [decisionRequest, requestAuth, setDecisionRequest, addEvent]);

  // CANCEL: dismiss the modal only — robot continues on its current route unchanged
  const handleCancel = useCallback(() => {
    setDecisionRequest(null);
    addEvent(`Decision dismissed — ${decisionRequest?.robotId} continues current route`, 'info');
  }, [decisionRequest, setDecisionRequest, addEvent]);

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
        <DecisionRequiredModal
          decisionRequest={decisionRequest}
          onWait={handleWait}
          onReroute={handleReroute}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
