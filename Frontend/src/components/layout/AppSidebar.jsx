import React from 'react';
import {
  ArrowLeft,
  Cpu,
  Grid,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Plus,
  ShieldAlert,
  ListTodo,
} from 'lucide-react';

import NavItem from './NavItem.jsx';
import { useAppActions, useAppState } from '@/context/appContext.js';
import { Button } from '@/components/ui/button.jsx';

export default function AppSidebar() {
  const { isSidebarOpen, session } = useAppState();
  const { logout, setIsSidebarOpen, navigate } = useAppActions();
  const roleLabel = session?.user?.role || session?.identity || 'Operator';

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 w-64 bg-background border-r border-border flex flex-col justify-between transform transition-transform duration-300 ease-in-out ${
        isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
      } `}
    >
      <div>
        <div className="h-16 flex items-center justify-between px-4 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="p-1.5 rounded-md bg-primary/10 text-foreground">
              <ShieldAlert className="w-5 h-5" />
            </span>
            <span className="font-semibold tracking-tight text-foreground">RobotX</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setIsSidebarOpen(false)}
            aria-label="Close sidebar"
            className="h-9 w-9"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </div>
        <nav className="p-3 space-y-1">
          <NavItem
            icon={<LayoutDashboard />}
            label="Dashboard"
            to="/"
            end
          />
          <NavItem icon={<Grid />} label="Robots" to="/robots" />
          <NavItem icon={<MapIcon />} label="Map Control" to="/map" />
          <NavItem icon={<ListTodo />} label="Tasks" to="/tasks" />
        </nav>
      </div>
      <div className="p-4 border-t border-border/40 space-y-3">
        {/* Two buttons, because they are two product flows. Commissioning registers
            hardware somebody installed; creating a simulated robot provisions a test
            agent owned by this operator. Neither is a mode of the other, and there is no
            Physical/Simulated choice inside either form. */}
        <Button type="button" onClick={() => navigate('/commission')} className="w-full" size="sm">
          <Plus className="w-4 h-4" /> Commission Physical Robot
        </Button>
        <Button
          type="button"
          onClick={() => navigate('/simulator/new')}
          className="w-full"
          size="sm"
          variant="secondary"
        >
          <Cpu className="w-4 h-4" /> Create Simulated Robot
        </Button>
        <Button type="button" onClick={logout} className="w-full" size="sm" variant="outline">
          <LogOut className="w-4 h-4" /> Logout
        </Button>
        <div className="pt-1 text-xs text-muted-foreground text-center truncate">{roleLabel}</div>
      </div>
    </aside>
  );
}
