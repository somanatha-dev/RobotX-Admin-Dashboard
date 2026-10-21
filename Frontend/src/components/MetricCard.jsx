import React from 'react';

import { Card } from './ui/card.jsx';

export default function MetricCard({ icon: Icon, title, value, subtext }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{title}</p>
          <p className="text-xl font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground truncate">{subtext}</p>
        </div>

        {Icon ? <Icon className="h-5 w-5 shrink-0 text-muted-foreground" /> : null}
      </div>
    </Card>
  );
}
