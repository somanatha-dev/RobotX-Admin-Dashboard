import React from 'react';
import {
  ArrowLeft,
  Grid,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Plus,
  ShieldAlert,
  ListTodo,
} from 'lucide-react';

import NavItem from './NavItem.jsx';
import { useAppActions, useAppState } from '../../context/appContext.js';

export default function AppSidebar() {
  const { effectiveRoute, isSidebarOpen } = useAppState();
  const { navigate, logout, setIsSidebarOpen, setIsCommissioning } = useAppActions();

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-950 border-r border-slate-900/60 flex flex-col justify-between transform transition-transform duration-300 ease-in-out ${
        isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
      } `}
    >
      <div>
        <div className="h-16 flex items-center justify-between px-6 border-b border-slate-900/60">
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-6 h-6 text-blue-400" />
            <span className="font-bold text-white tracking-wider">RobotX</span>
          </div>
          <button
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="p-2 rounded-lg border border-slate-800/60 bg-slate-950/40 hover:bg-slate-900/60 text-slate-200 transition-colors"
            aria-label="Close sidebar"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </div>
        <nav className="p-4 space-y-1">
          <NavItem
            icon={<LayoutDashboard />}
            label="Dashboard"
            active={effectiveRoute === '/dashboard'}
            onClick={() => navigate('/dashboard')}
          />
          <NavItem icon={<Grid />} label="Robots" active={effectiveRoute === '/robots'} onClick={() => navigate('/robots')} />
          <NavItem icon={<MapIcon />} label="Map Control" active={effectiveRoute === '/map'} onClick={() => navigate('/map')} />
          <NavItem icon={<ListTodo />} label="Tasks" active={effectiveRoute === '/tasks'} onClick={() => navigate('/tasks')} />
        </nav>
      </div>
      <div className="p-6 border-t border-slate-900/60">
        <button
          type="button"
          onClick={() => setIsCommissioning(true)}
          className="w-full flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white py-2.5 rounded-lg text-sm font-bold transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" /> Commission Unit
        </button>
        <button
          type="button"
          onClick={logout}
          className="mt-3 w-full flex items-center justify-center gap-2 bg-transparent border border-slate-800/60 hover:bg-slate-900/40 text-slate-200 py-2.5 rounded-lg text-sm font-bold transition-colors"
        >
          <LogOut className="w-4 h-4" /> Logout
        </button>
        <div className="mt-4 text-xs text-slate-400/60 font-mono text-center">System v2.4.1-prod</div>
      </div>
    </aside>
  );
}
