import React from 'react';
import { Bell, Menu } from 'lucide-react';

import NotificationsMenu from './NotificationsMenu.jsx';
import { useAppActions, useAppState } from '../../context/appContext.js';

export default function AppTopBar() {
  const {
    routeTitle,
    isSidebarOpen,
    events,
    bellButtonRef,
  } = useAppState();
  const { setIsSidebarOpen, setIsNotificationsOpen, navigate } = useAppActions();

  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 lg:px-6 shrink-0 z-20 relative">
      <div className="flex items-center gap-3">
        {!isSidebarOpen && (
          <button
            type="button"
            className="text-slate-700 p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
            onClick={() => setIsSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}
        <div className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">{routeTitle}</div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            ref={bellButtonRef}
            type="button"
            onClick={() => setIsNotificationsOpen((v) => !v)}
            className="relative p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 transition-colors"
            aria-label="Notifications"
          >
            <Bell className="w-5 h-5" />
            {events.length > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center">
                {Math.min(events.length, 9)}
              </span>
            )}
          </button>

          <NotificationsMenu />
        </div>

        <button
          type="button"
          onClick={() => navigate('/profile')}
          className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
          aria-label="Open profile"
        >
          <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-bold">RX</div>
          <div className="hidden sm:block text-sm font-semibold text-slate-700">Profile</div>
        </button>
      </div>
    </header>
  );
}
