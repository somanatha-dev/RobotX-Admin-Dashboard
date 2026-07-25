import React from 'react';
import { NavLink } from 'react-router-dom';

import { cn } from '@/lib/utils.js';

export default function NavItem({ icon, label, to, end, active, onClick, badge }) {
  if (to) {
    return (
      <NavLink
        to={to}
        end={end}
        onClick={onClick}
        className={({ isActive }) =>
          cn(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group relative text-muted-foreground hover:bg-muted/50',
            isActive && 'bg-muted text-foreground font-medium'
          )
        }
      >
        {({ isActive }) => (
          <>
            <span
              className={cn(
                'absolute left-0 top-2 bottom-2 w-1 rounded-r bg-primary transition-opacity',
                isActive ? 'opacity-100' : 'opacity-0'
              )}
              aria-hidden="true"
            />

            <span className="p-1.5 rounded-md bg-primary/10 text-foreground transition-all duration-200">
              {icon}
            </span>
            <span className="text-sm">{label}</span>
            {badge > 0 && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 bg-primary text-primary-foreground text-[10px] font-semibold px-2 py-0.5 rounded-full shadow-sm">
                {badge}
              </div>
            )}
          </>
        )}
      </NavLink>
    );
  }

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group relative text-muted-foreground hover:bg-muted/50',
        active && 'bg-muted text-foreground font-medium'
      )}
    >
      <span
        className={cn(
          'absolute left-0 top-2 bottom-2 w-1 rounded-r bg-primary transition-opacity',
          active ? 'opacity-100' : 'opacity-0'
        )}
        aria-hidden="true"
      />

      <span className="p-1.5 rounded-md bg-primary/10 text-foreground transition-all duration-200">
        {icon}
      </span>
      <span className="text-sm">{label}</span>
      {badge > 0 && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 bg-primary text-primary-foreground text-[10px] font-semibold px-2 py-0.5 rounded-full shadow-sm">
          {badge}
        </div>
      )}
    </button>
  );
}
