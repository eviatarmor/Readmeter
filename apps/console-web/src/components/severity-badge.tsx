import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const severityClass: Record<string, string> = {
  critical: "border-transparent bg-red-600/15 text-red-700 dark:text-red-300",
  high: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-300",
  medium: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-200",
  low: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-300",
  info: "border-transparent bg-muted text-muted-foreground",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge variant="outline" className={cn("capitalize", severityClass[severity] ?? severityClass.info)}>
      {severity}
    </Badge>
  );
}

const statusClass: Record<string, string> = {
  open: "border-transparent bg-secondary text-secondary-foreground",
  resolved: "border-transparent bg-emerald-600/15 text-emerald-700 dark:text-emerald-300",
  ignored: "border-transparent bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("capitalize", statusClass[status] ?? statusClass.open)}>
      {status}
    </Badge>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}
