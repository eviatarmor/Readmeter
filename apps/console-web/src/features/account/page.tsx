import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { useTheme } from "next-themes";

import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";

interface SessionRow {
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt?: string | Date;
}

export function AccountPage() {
  const session = authClient.useSession();
  const { theme, setTheme } = useTheme();
  const user = session.data?.user;
  const [name, setName] = React.useState(user?.name ?? "");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const result = await authClient.listSessions();
      if (result.error) throw new Error(result.error.message);
      return (result.data ?? []) as SessionRow[];
    },
  });

  React.useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user?.name]);

  return (
    <div className="grid max-w-xl gap-6">
      <PageHeader title="Profile" description={user?.email} />
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void authClient.updateUser({ name }).then((result) => {
            if (result.error) {
              toast.error(result.error.message ?? "Could not update profile");
              return;
            }
            toast.success("Profile saved");
            void queryClient.invalidateQueries({ queryKey: ["me"] });
          });
        }}
      >
        <Label htmlFor="account-name">Name</Label>
        <Input id="account-name" value={name} onChange={(event) => setName(event.target.value)} />
        <Label htmlFor="account-email">Email</Label>
        <Input id="account-email" value={user?.email ?? ""} disabled />
        <Button type="submit">Save profile</Button>
      </form>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void authClient
            .changePassword({ currentPassword, newPassword, revokeOtherSessions: false })
            .then((result) => {
              if (result.error) {
                toast.error(result.error.message ?? "Could not change password");
                return;
              }
              setCurrentPassword("");
              setNewPassword("");
              toast.success("Password updated");
            });
        }}
      >
        <Label htmlFor="current-password">Current password</Label>
        <Input id="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" minLength={10} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        <Button type="submit">Change password</Button>
      </form>
      <div className="grid gap-2">
        <h2 className="text-sm font-medium">Theme</h2>
        <div className="flex gap-2">
          {(["light", "dark", "system"] as const).map((value) => (
            <Button key={value} type="button" variant={theme === value ? "default" : "outline"} onClick={() => setTheme(value)}>
              {value}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid gap-2">
        <h2 className="text-sm font-medium">Sessions</h2>
        {(sessions.data ?? []).map((item) => (
          <div key={item.token} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
            <span>
              {item.userAgent ?? "Session"} <RelativeTime value={item.createdAt ? String(item.createdAt) : null} />
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void authClient.revokeSession({ token: item.token }).then(() => {
                  toast.success("Session revoked");
                  void sessions.refetch();
                });
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
