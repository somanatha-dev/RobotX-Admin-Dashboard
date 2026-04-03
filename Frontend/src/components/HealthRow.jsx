import React from 'react';
import { Check, X } from 'lucide-react';

import { Badge } from './ui/badge.jsx';

export default function HealthRow({ label, status }) {
  return (
    <div className="flex justify-between items-center py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      {status ? (
        <Badge variant="secondary" className="gap-1.5">
          <Check className="w-3.5 h-3.5" /> OK
        </Badge>
      ) : (
        <Badge variant="destructive" className="gap-1.5">
          <X className="w-3.5 h-3.5" /> FAIL
        </Badge>
      )}
    </div>
  );
}
