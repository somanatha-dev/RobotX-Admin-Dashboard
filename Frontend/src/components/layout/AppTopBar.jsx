import React from 'react';
import { Bell, Menu } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import NotificationsMenu from './NotificationsMenu.jsx';
import { useAppActions, useAppState } from '@/context/appContext.js';
import { Button } from '@/components/ui/button.jsx';
import { Avatar, AvatarFallback } from '@/components/ui/avatar.jsx';
import { getRouteTitle } from '@/router/routeTitles.js';

export default function AppTopBar() {
  const {
    isSidebarOpen,
    events,
    bellButtonRef,
    session,
    preferences,
  } = useAppState();
  const { setIsSidebarOpen } = useAppActions();

  const location = useLocation();
  const navigate = useNavigate();
  const routeTitle = getRouteTitle(location.pathname);

  const email = session?.user?.email || session?.identity || '';
  const initial = String(email).trim().charAt(0).toUpperCase() || 'U';

  return (
    // Sticky, so on a phone — where `main` scrolls the whole page — the menu and the page's
    // name stay in reach.
    <header className="sticky top-0 h-14 sm:h-16 bg-background/95 backdrop-blur border-b border-border/60 flex items-center justify-between gap-2 px-3 sm:px-6 shrink-0 z-20">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {!isSidebarOpen && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setIsSidebarOpen(true)}
            aria-label="Open sidebar"
            className="h-9 w-9 shrink-0"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
        <div className="text-lg sm:text-2xl font-semibold tracking-tight truncate">{routeTitle}</div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {preferences?.notificationsEnabled ? (
          <NotificationsMenu>
            <Button
              ref={bellButtonRef}
              type="button"
              variant="outline"
              size="icon"
              className="relative h-9 w-9"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5" />
              {events.length > 0 && (
                <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center">
                  {Math.min(events.length, 9)}
                </span>
              )}
            </Button>
          </NotificationsMenu>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="relative h-9 w-9"
            aria-label="Notifications disabled"
            disabled
          >
            <Bell className="h-5 w-5" />
          </Button>
        )}

        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/profile')}
          className="gap-2 h-9 px-1.5 sm:px-3"
          aria-label="Open profile"
        >
          <Avatar className="h-7 w-7 sm:h-8 sm:w-8">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="hidden sm:block text-sm font-medium">Profile</div>
        </Button>
      </div>
    </header>
  );
}
