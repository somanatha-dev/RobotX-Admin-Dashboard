// @ts-nocheck
import React from 'react';
import { Outlet } from 'react-router-dom';

import AuthChallengeModal from '../components/modals/AuthChallengeModal.jsx';
import CreateTaskModal from '../components/modals/CreateTaskModal.jsx';
import DecisionRequiredModal from '../components/modals/DecisionRequiredModal.jsx';
import * as tasksApi from '../lib/api/tasks.js';

import AppSidebar from '../components/layout/AppSidebar.jsx';
import AppTopBar from '../components/layout/AppTopBar.jsx';
import { useAppActions, useAppState } from '../context/appContext.js';

export default function Layout() {
  const {
    isSidebarOpen,
    authRequest,
    isCreatingTask,
    decisionRequest,
  } = useAppState();

  const {
    setAuthRequest,
    setIsCreatingTask,
    createTask,
    requestAuth,
    setDecisionRequest,
    addEvent,
  } = useAppActions();

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
          onWait={() => setDecisionRequest(null)}
          onReroute={() =>
            requestAuth('SWARM OVERRIDE: REROUTE', () => {
              addEvent(`Manual reroute confirmed for ${decisionRequest?.robotId}`, 'info');
              setDecisionRequest(null);
            })
          }
          onCancel={() =>
            requestAuth('SWARM OVERRIDE: CANCEL TASK', async () => {
              // Direct API call — cannot use the cancelTask action because it
              // wraps in requestAuth again, which would nest two auth modals.
              const taskId = decisionRequest?.taskId;
              if (taskId) {
                await tasksApi.cancelTask(taskId).catch(() => {});
                addEvent(`Task ${taskId} cancelled via swarm override`, 'warning');
              }
              setDecisionRequest(null);
            })
          }
        />
      )}
    </div>
  );
}
