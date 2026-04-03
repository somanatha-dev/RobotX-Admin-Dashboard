import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { ReactNode } from "react";

export function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>

      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}
