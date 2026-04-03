import React from 'react';
import { ChevronRight, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAppActions, useAppState } from '../../context/appContext.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from '../ui/dropdown-menu.jsx';
import { Button } from '../ui/button.jsx';
import { cn } from '../../lib/utils.js';

function typeDotClass(type) {
  if (type === 'critical') return 'bg-destructive';
  if (type === 'warning') return 'bg-secondary';
  return 'bg-primary';
}

export default function NotificationsMenu({ children }) {
  const { events, isNotificationsOpen, notificationsRef } = useAppState();
  const { setIsNotificationsOpen } = useAppActions();
  const navigate = useNavigate();

  return (
    <DropdownMenu open={isNotificationsOpen} onOpenChange={setIsNotificationsOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        ref={notificationsRef}
        align="end"
        className="w-80 p-0 overflow-hidden"
      >
        <div className="px-3 py-2 flex items-center justify-between">
          <DropdownMenuLabel className="px-0 py-0">Notifications</DropdownMenuLabel>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setIsNotificationsOpen(false)}
            aria-label="Close notifications"
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <DropdownMenuSeparator />

        <div className="max-h-80 overflow-y-auto divide-y divide-border">
          {events.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground text-center">No notifications.</div>
          ) : (
            events.map((ev) => (
              <DropdownMenuItem
                key={ev.id}
                className="px-3 py-2 rounded-none"
                onSelect={() => {
                  setIsNotificationsOpen(false);
                  navigate('/');
                }}
              >
                <div className="w-full flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <span
                      className={cn('mt-1 h-2 w-2 rounded-full shadow-sm', typeDotClass(ev.type))}
                      aria-hidden="true"
                    />
                    <div>
                      <div className="text-sm font-medium text-foreground">{ev.msg}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{ev.time}</div>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground mt-1" />
                </div>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
