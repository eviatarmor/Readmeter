import { DatabaseIcon, FlameIcon } from "lucide-react";

const SERVICES = [
  { value: "firestore", label: "Cloud Firestore", icon: FlameIcon },
  { value: "database", label: "Realtime Database", icon: DatabaseIcon },
] as const;

export const serviceOptions = SERVICES.map((service) => ({
  label: service.label,
  value: service.value,
  icon: service.icon,
}));

function knownService(service: string) {
  const exact = SERVICES.find((item) => item.value === service);
  if (exact) return exact;
  // Cost groups are `provider/service` (`firebase/database`). Rule ids and
  // templates also contain a slash and must stay as written.
  const slash = service.indexOf("/");
  if (slash <= 0 || slash !== service.lastIndexOf("/")) return undefined;
  const id = service.slice(slash + 1);
  return SERVICES.find((item) => item.value === id);
}

export function serviceLabel(service: string): string {
  return knownService(service)?.label ?? service;
}

export function ServiceName({ service }: { service: string }) {
  const known = knownService(service);
  const label = known?.label ?? service;
  const Icon = known?.icon;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={label}>
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}
