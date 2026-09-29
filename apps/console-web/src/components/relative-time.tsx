import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAbsolute, formatRelative, formatRelativeCompact } from "@/lib/format-value";
import { cn } from "@/lib/utils";

export function RelativeTime({
  value,
  className,
  compact = false,
}: {
  value: string | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const label = compact ? formatRelativeCompact(value) : formatRelative(value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={value} className={cn("text-muted-foreground", className ?? "whitespace-nowrap")}>
          {label}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatAbsolute(value)}</TooltipContent>
    </Tooltip>
  );
}
