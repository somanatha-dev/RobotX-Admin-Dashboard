import React from 'react';
import { ChevronRight, X } from 'lucide-react';

import { useAppActions, useAppState } from '../../context/appContext.js';

export default function NotificationsMenu() {
  const { events, isNotificationsOpen, notificationsRef } = useAppState();
  const { setIsNotificationsOpen, navigate } = useAppActions();

  if (!isNotificationsOpen) return null;

  return (
    <div
      ref={notificationsRef}
      className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-30"
    >
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
        <div className="text-xs font-bold text-slate-600 uppercase tracking-wider">Notifications</div>
        <button
          type="button"
          onClick={() => setIsNotificationsOpen(false)}
          className="p-1 rounded-md hover:bg-slate-200 text-slate-500"
          aria-label="Close notifications"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
        {events.length === 0 ? (
          <div className="p-6 text-sm text-slate-500 text-center">No notifications.</div>
        ) : (
          events.map((ev) => (
            <button
              key={ev.id}
              type="button"
              onClick={() => {
                setIsNotificationsOpen(false);
                navigate('/dashboard');
              }}
              className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <span
                    className={`mt-1 w-2 h-2 rounded-full ${
                      ev.type === 'critical'
                        ? 'bg-rose-500'
                        : ev.type === 'warning'
                          ? 'bg-amber-500'
                          : 'bg-blue-500'
                    }`}
                  />
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{ev.msg}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{ev.time}</div>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-300 mt-1" />
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
