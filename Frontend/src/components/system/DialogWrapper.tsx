import { Dialog, DialogContent } from "@/components/ui/dialog";

import type { ReactNode } from "react";

export function DialogWrapper({
  children,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-xl">{children}</DialogContent>
    </Dialog>
  );
}
