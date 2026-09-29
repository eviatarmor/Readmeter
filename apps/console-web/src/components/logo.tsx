import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background",
        className,
      )}
    >
      Rm
    </span>
  );
}
