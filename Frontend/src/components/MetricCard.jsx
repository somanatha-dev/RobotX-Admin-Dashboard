import React from 'react';

import { Card } from './ui/card.jsx';

export default function MetricCard({ icon: Icon, title, value, subtext }) {
  return (
    <Card className="p-4">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-xs text-muted-foreground">{title}</p>
          <p className="text-xl font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground">{subtext}</p>
        </div>

        {Icon ? <Icon className="h-5 w-5 text-muted-foreground" /> : null}
      </div>
    </Card>
  );
}
