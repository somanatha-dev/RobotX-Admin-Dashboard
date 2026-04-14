import React from 'react';
import { Outlet } from 'react-router-dom';

import AuthChallengeModal from '../components/modals/AuthChallengeModal.jsx';
import CreateTaskModal from '../components/modals/CreateTaskModal.jsx';
import DecisionRequiredModal from '../components/modals/DecisionRequiredModal.jsx';

import AppSidebar from '../components/layout/AppSidebar.jsx';
import AppTopBar from '../components/layout/AppTopBar.jsx';
import { useAppActions, useAppState } from '../context/appContext.js';

export default function AppShell() {
  const {
    isSidebarOpen,
    authRequest,
    isCreatingTask,
    decisionRequest,
    robots,
  } = useAppState();

  const {
    setAuthRequest,
    setIsCreatingTask,
    createTask,
    requestAuth,
    setDecisionRequest,
  } = useAppActions();

  return (
    <div className="bg-muted/30 min-h-screen flex h-screen w-full text-foreground overflow-hidden">
      <AppSidebar />

      {isSidebarOpen && <div className="fixed inset-0 bg-foreground/40 backdrop-blur-sm z-30 lg:hidden" />}

      <main className="flex-1 overflow-hidden">
        <div
          className={`h-full flex flex-col min-w-0 relative transition-[padding] duration-300 ease-in-out ${
            isSidebarOpen ? 'lg:pl-64' : 'lg:pl-0'
          }`}
        >
          <AppTopBar />
          <div className="flex-1 overflow-hidden min-h-0">
            <div className="h-full overflow-auto p-6 space-y-6">
              <Outlet />
            </div>
          </div>
        </div>
      </main>

      {authRequest && <AuthChallengeModal request={authRequest} onClose={() => setAuthRequest(null)} />}
      {isCreatingTask && (
        <CreateTaskModal robots={robots} onClose={() => setIsCreatingTask(false)} onCreate={createTask} />
      )}

      {decisionRequest && !authRequest && (
        <DecisionRequiredModal
          decisionRequest={decisionRequest}
          onWait={() => setDecisionRequest(null)}
          onReroute={() => requestAuth('SWARM OVERRIDE: REROUTE', () => setDecisionRequest(null))}
          onCancel={() => requestAuth('SWARM OVERRIDE: CANCEL TASK', () => setDecisionRequest(null))}
        />
      )}
    </div>
  );
}
