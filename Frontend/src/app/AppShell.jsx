import React from 'react';

import AuthChallengeModal from '../components/modals/AuthChallengeModal.jsx';
import CommissionModal from '../components/modals/CommissionModal.jsx';
import CreateTaskModal from '../components/modals/CreateTaskModal.jsx';
import DecisionRequiredModal from '../components/modals/DecisionRequiredModal.jsx';

import LoginPage from '../pages/LoginPage.jsx';

import AppSidebar from '../components/layout/AppSidebar.jsx';
import AppTopBar from '../components/layout/AppTopBar.jsx';
import AppContent from '../routes/AppContent.jsx';
import { useAppActions, useAppState } from '../context/appContext.js';

export default function AppShell() {
  const {
    effectiveRoute,
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

  if (effectiveRoute === '/login') {
    return <LoginPage />;
  }

  return (
    <div className="h-screen w-full bg-slate-50 text-slate-900 font-sans overflow-hidden selection:bg-blue-100">
      <AppSidebar />

      {isSidebarOpen && <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm z-30 lg:hidden" />}

      <main
        className={`h-full w-full flex flex-col min-w-0 relative transition-[padding] duration-300 ease-in-out ${
          isSidebarOpen ? 'lg:pl-64' : 'lg:pl-0'
        }`}
      >
        <AppTopBar />
        <div className="flex-1 overflow-hidden relative min-h-0">
          <AppContent />
        </div>
      </main>

      {authRequest && <AuthChallengeModal request={authRequest} onClose={() => setAuthRequest(null)} />}
      {isCommissioning && <CommissionModal onClose={() => setIsCommissioning(false)} onCommission={commission} />}
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
