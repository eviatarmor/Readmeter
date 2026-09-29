import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAbsolute, formatRelative } from "@/lib/format-value";

export function RelativeTime({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={value} className="whitespace-nowrap text-muted-foreground">
          {formatRelative(value)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatAbsolute(value)}</TooltipContent>
    </Tooltip>
  );
}
