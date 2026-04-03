// @ts-nocheck
import React from 'react';
import { Outlet } from 'react-router-dom';

import AuthChallengeModal from '../components/modals/AuthChallengeModal.jsx';
import CommissionModal from '../components/modals/CommissionModal.jsx';
import CreateTaskModal from '../components/modals/CreateTaskModal.jsx';
import DecisionRequiredModal from '../components/modals/DecisionRequiredModal.jsx';

import AppSidebar from '../components/layout/AppSidebar.jsx';
import AppTopBar from '../components/layout/AppTopBar.jsx';
import { useAppActions, useAppState } from '../context/appContext.js';

export default function Layout() {
  const {
    isSidebarOpen,
    authRequest,
    isCommissioning,
    isCreatingTask,
    decisionRequest,
    robots,
  } = useAppState();

  const {
    setAuthRequest,
    setIsCommissioning,
    setIsCreatingTask,
    commission,
    createTask,
    requestAuth,
    setDecisionRequest,
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
      {isCommissioning && (
        <CommissionModal onClose={() => setIsCommissioning(false)} onCommission={commission} />
      )}
      {isCreatingTask && (
        <CreateTaskModal robots={robots} onClose={() => setIsCreatingTask(false)} onCreate={createTask} />
      )}

      {decisionRequest && !authRequest && !isCommissioning && (
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
