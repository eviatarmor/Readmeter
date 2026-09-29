import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";

import type { Invitation, Member, Role } from "@readmeter/console-api/contract";

import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { ResourceTable } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useInvitations, useMembers } from "@/features/members/queries";
import { ApiError, api } from "@/lib/api";
import type { DataTableFeatures } from "@/lib/data-table-features";
import type { QueryKeys } from "@/lib/data-table-types";
import { canManage } from "@/lib/permissions";
import { queryClient } from "@/lib/query-client";

const memberKeys: QueryKeys = {
  page: "mpage",
  perPage: "mperPage",
  sort: "msort",
  filters: "mfilters",
  joinOperator: "mjoin",
};

const roles: Role[] = ["owner", "admin", "member"];

export function MembersPage({ slug, role }: { slug: string; role: Role | undefined }) {
  const members = useMembers(slug);
  const manage = canManage(role);
  const invitations = useInvitations(slug, manage);
  const [open, setOpen] = React.useState(false);
  const [links, setLinks] = React.useState<string[]>([]);
  const ownerCount = (members.data ?? []).filter((member) => member.role === "owner").length;
  const columns = React.useMemo(
    () => memberColumns(slug, manage, ownerCount),
    [slug, manage, ownerCount],
  );
  if (members.isError) return <QueryError message="Could not load members" onRetry={() => void members.refetch()} />;
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Members"
        description="Owners and admins invite people. The last owner cannot be removed."
        actions={manage ? <Button onClick={() => setOpen(true)}>Invite</Button> : null}
      />
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          {manage ? <TabsTrigger value="invitations">Invitations</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="members" className="pt-4">
          <ResourceTable
            data={members.data ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            queryKeys={memberKeys}
            isLoading={members.isLoading}
          />
        </TabsContent>
        {manage ? (
          <TabsContent value="invitations" className="pt-4">
            <InvitationList slug={slug} items={invitations.data ?? []} />
          </TabsContent>
        ) : null}
      </Tabs>
      <InviteDialog
        slug={slug}
        open={open}
        onOpenChange={setOpen}
        onLinks={setLinks}
      />
      {links.length > 0 ? (
        <div className="grid gap-2 rounded-lg border p-3 text-sm">
          {links.map((link) => (
            <a key={link} href={link} data-testid="invite-link" className="break-all font-mono text-xs">
              {link}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function memberColumns(slug: string, manage: boolean, ownerCount: number): ColumnDef<DataTableFeatures, Member>[] {
  return [
    {
      id: "name",
      accessorFn: (row) => row.user.name,
      header: ({ column }) => <DataTableColumnHeader column={column} label="Name" />,
      enableColumnFilter: true,
      meta: { label: "Name", variant: "text" },
    },
    {
      id: "email",
      accessorFn: (row) => row.user.email,
      header: "Email",
      enableColumnFilter: true,
      meta: { label: "Email", variant: "text" },
    },
    {
      id: "role",
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) =>
        manage ? (
          <Select
            value={row.original.role}
            onValueChange={(value) => {
              if (!value || value === row.original.role) return;
              void updateRole(slug, row.original, value as Role);
            }}
          >
            <SelectTrigger className="w-28" aria-label={`Role for ${row.original.user.email}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((item) => (
                <SelectItem
                  key={item}
                  value={item}
                  disabled={row.original.role === "owner" && ownerCount <= 1 && item !== "owner"}
                >
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          row.original.role
        ),
    },
    {
      id: "joined",
      accessorKey: "joined",
      header: "Joined",
      cell: ({ row }) => <RelativeTime value={row.original.joined} />,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const lastOwner = row.original.role === "owner" && ownerCount <= 1;
        if (!manage) return null;
        return (
          <Button
            variant="outline"
            size="sm"
            disabled={lastOwner}
            title={lastOwner ? "The last owner cannot be removed" : undefined}
            onClick={() => void removeMember(slug, row.original)}
          >
            Remove
          </Button>
        );
      },
    },
  ];
}

async function updateRole(slug: string, member: Member, role: Role) {
  try {
    await api(`/api/v1/workspaces/${slug}/members/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    toast.success("Role updated");
    void queryClient.invalidateQueries({ queryKey: ["members", slug] });
  } catch (error) {
    toast.error(error instanceof ApiError ? error.message : "Could not update role");
  }
}

async function removeMember(slug: string, member: Member) {
  try {
    await api(`/api/v1/workspaces/${slug}/members/${member.id}`, { method: "DELETE" });
    toast.success("Member removed");
    void queryClient.invalidateQueries({ queryKey: ["members", slug] });
  } catch (error) {
    toast.error(error instanceof ApiError ? error.message : "Could not remove member");
  }
}

function InvitationList({ slug, items }: { slug: string; items: Invitation[] }) {
  return (
    <div className="grid gap-2">
      {items.length === 0 ? <p className="text-sm text-muted-foreground">No invitations.</p> : null}
      {items.map((invitation) => (
        <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
          <span>
            {invitation.email} · {invitation.role} · {invitation.status}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void api(`/api/v1/workspaces/${slug}/invitations/${invitation.id}`, { method: "DELETE" })
                .then(() => {
                  toast.success("Invitation cancelled");
                  void queryClient.invalidateQueries({ queryKey: ["invitations", slug] });
                })
                .catch((error: unknown) => toast.error(error instanceof ApiError ? error.message : "Could not cancel"));
            }}
          >
            Cancel
          </Button>
        </div>
      ))}
    </div>
  );
}

function InviteDialog({
  slug,
  open,
  onOpenChange,
  onLinks,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinks: (links: string[]) => void;
}) {
  const [emails, setEmails] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");
  const invite = useMutation({
    mutationFn: async () => {
      const list = emails
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const links: string[] = [];
      for (const email of list) {
        const created = await api<Invitation>(`/api/v1/workspaces/${slug}/invitations`, {
          method: "POST",
          body: JSON.stringify({ email, role }),
        });
        if (created.link) links.push(created.link);
      }
      return links;
    },
    onSuccess: (links) => {
      toast.success(links.length > 0 ? "Invitation ready" : "Invitation sent");
      onLinks(links);
      setEmails("");
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["invitations", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not invite"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite members</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="invite-emails">Emails</Label>
          <Textarea
            id="invite-emails"
            placeholder="one@example.com"
            value={emails}
            onChange={(event) => setEmails(event.target.value)}
          />
          <Label>Role</Label>
          <Select value={role} onValueChange={(value) => value && setRole(value as Role)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" disabled={emails.trim().length === 0 || invite.isPending} onClick={() => invite.mutate()}>
            Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
