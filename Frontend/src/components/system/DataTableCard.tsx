import { Card, CardContent } from "@/components/ui/card";

import type { ReactNode } from "react";

export function DataTableCard({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}
