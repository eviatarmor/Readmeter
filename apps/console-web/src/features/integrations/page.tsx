import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import type { GcpCheck, GcpConnection, Project, Role } from "@readmeter/console-api/contract";

import { CopyButton } from "@/components/code-block";
import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DOCS_URL } from "@/components/shell/nav";
import { useGcp } from "@/features/integrations/queries";
import { useProjects } from "@/features/projects/queries";
import { ApiError, api } from "@/lib/api";
import { canManage } from "@/lib/permissions";
import { queryClient } from "@/lib/query-client";
import type { WorkspaceSearch } from "@/lib/workspace-search";

const BILLING_DOCS = "https://cloud.google.com/billing/docs/how-to/export-data-bigquery";

export function IntegrationsPage({
  slug,
  search,
  role,
}: {
  slug: string;
  search: WorkspaceSearch;
  role: Role | undefined;
}) {
  const projects = useProjects(slug);
  const manage = canManage(role);
  const scoped = (projects.data ?? []).filter((project) => !search.project || project.id === search.project);
  if (projects.isError) return <QueryError message="Could not load projects" onRetry={() => void projects.refetch()} />;
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Integrations"
        description="Connect a read-only Google Cloud service account to import Monitoring usage and, optionally, the billing export."
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Google Cloud</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            The account needs Monitoring Viewer. Billing export adds BigQuery Data Viewer and Job User. Nothing here
            needs write access.
          </p>
          {projects.isLoading ? <p className="text-sm text-muted-foreground">Loading projects…</p> : null}
          {scoped.length === 0 && !projects.isLoading ? (
            <p className="text-sm text-muted-foreground">Create a project before connecting Google Cloud.</p>
          ) : null}
          {scoped.map((project) => (
            <GcpProjectCard key={project.id} slug={slug} project={project} manage={manage} />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                SDK docs
              </a>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/w/$slug/projects" params={{ slug }} search={search}>
                Project install snippets
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GcpProjectCard({ slug, project, manage }: { slug: string; project: Project; manage: boolean }) {
  const query = useGcp(slug, project.id, manage);
  const [wizard, setWizard] = React.useState(false);
  const [disconnect, setDisconnect] = React.useState(false);
  const connection = query.data?.connection ?? null;
  const sync = useMutation({
    mutationFn: () => api(`/api/v1/workspaces/${slug}/projects/${project.id}/gcp/sync`, { method: "POST", body: "{}" }),
    onSuccess: async () => {
      toast.success("Sync queued");
      await queryClient.invalidateQueries({ queryKey: ["gcp", slug, project.id] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not queue sync"),
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ checks: GcpCheck[] }>(`/api/v1/workspaces/${slug}/projects/${project.id}/gcp/test`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: async (result) => {
      const failed = result.checks.filter((check) => !check.ok);
      if (failed.length > 0) toast.error(failed.map((check) => check.message).join("; "));
      else toast.success("Connection test passed");
      await queryClient.invalidateQueries({ queryKey: ["gcp", slug, project.id] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Test failed"),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/workspaces/${slug}/projects/${project.id}/gcp`, { method: "DELETE", body: "{}" }),
    onSuccess: async () => {
      toast.success("Google Cloud disconnected");
      setDisconnect(false);
      await queryClient.invalidateQueries({ queryKey: ["gcp", slug, project.id] });
      await queryClient.invalidateQueries({ queryKey: ["costs", slug] });
      await queryClient.invalidateQueries({ queryKey: ["overview", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not disconnect"),
  });
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{project.name}</p>
          <p className="text-xs text-muted-foreground">{project.firebaseProjectId ?? "Firebase project id not set"}</p>
        </div>
        {connection ? <StatusBadge status={connection.status} /> : <Badge variant="outline">Not connected</Badge>}
      </div>
      {connection ? (
        <dl className="grid gap-1 text-sm">
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground">Service account</dt>
            <dd className="font-mono text-xs">{connection.clientEmail}</dd>
          </div>
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground">GCP project</dt>
            <dd className="font-mono text-xs">{connection.gcpProjectId}</dd>
          </div>
          <div className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground">Billing table</dt>
            <dd className="font-mono text-xs">{connection.billingTable ?? "Not set"}</dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="text-muted-foreground">Last sync</dt>
            <dd>
              <RelativeTime value={connection.lastSyncAt} testId="gcp-last-sync" />
            </dd>
          </div>
          {connection.lastError ? <p className="text-sm text-destructive">{connection.lastError}</p> : null}
        </dl>
      ) : null}
      {manage ? (
        <div className="flex flex-wrap gap-2">
          <Button data-testid="gcp-connect" onClick={() => setWizard(true)}>
            {connection ? "Replace key" : "Connect"}
          </Button>
          {connection ? (
            <>
              <Button variant="outline" data-testid="gcp-sync" disabled={sync.isPending} onClick={() => sync.mutate()}>
                Sync now
              </Button>
              <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                Test
              </Button>
              <Button variant="outline" onClick={() => setDisconnect(true)}>
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Owners and admins can connect Google Cloud.</p>
      )}
      <ConnectWizard
        slug={slug}
        project={project}
        open={wizard}
        replacing={Boolean(connection)}
        onOpenChange={setWizard}
      />
      <AlertDialog open={disconnect} onOpenChange={setDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove connection</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the stored key and the imported usage and cost rows for {project.name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate()}>
              Remove connection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ status }: { status: GcpConnection["status"] }) {
  if (status === "ok") return <Badge>Connected</Badge>;
  if (status === "error") return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

function ConnectWizard({
  slug,
  project,
  open,
  replacing,
  onOpenChange,
}: {
  slug: string;
  project: Project;
  open: boolean;
  replacing: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = React.useState(1);
  const [jsonText, setJsonText] = React.useState("");
  const [billingTable, setBillingTable] = React.useState("");
  const [checks, setChecks] = React.useState<GcpCheck[] | null>(null);
  const gcpProject = project.firebaseProjectId?.trim() || "FIREBASE_PROJECT_ID";
  const email = `readmeter-reader@${gcpProject}.iam.gserviceaccount.com`;
  const commands = [
    `gcloud iam service-accounts create readmeter-reader --project ${gcpProject} --display-name "Readmeter reader"`,
    `gcloud iam service-accounts keys create readmeter-key.json --iam-account ${email} --project ${gcpProject}`,
    `gcloud projects add-iam-policy-binding ${gcpProject} --member serviceAccount:${email} --role roles/monitoring.viewer`,
    `gcloud bigquery datasets add-iam-policy-binding DATASET_ID --project BILLING_PROJECT_ID --member serviceAccount:${email} --role roles/bigquery.dataViewer`,
    `gcloud projects add-iam-policy-binding BILLING_PROJECT_ID --member serviceAccount:${email} --role roles/bigquery.jobUser`,
  ];
  const save = useMutation({
    mutationFn: () =>
      api<{ connection: GcpConnection; checks: GcpCheck[] }>(`/api/v1/workspaces/${slug}/projects/${project.id}/gcp`, {
        method: "PUT",
        body: JSON.stringify({
          serviceAccountJson: jsonText,
          ...(project.firebaseProjectId ? { gcpProjectId: project.firebaseProjectId } : {}),
          ...(billingTable.trim() ? { billingTable: billingTable.trim() } : {}),
        }),
      }),
    onSuccess: async (result) => {
      setChecks(result.checks);
      await queryClient.invalidateQueries({ queryKey: ["gcp", slug, project.id] });
      await queryClient.invalidateQueries({ queryKey: ["costs", slug] });
      await queryClient.invalidateQueries({ queryKey: ["overview", slug] });
      if (result.checks.every((check) => check.ok)) {
        setJsonText("");
        setStep(5);
      }
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not store the key"),
  });
  function close(next: boolean) {
    if (!next) {
      setStep(1);
      setJsonText("");
      setBillingTable("");
      setChecks(null);
    }
    onOpenChange(next);
  }
  const parsed = keyShape(jsonText);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{replacing ? "Replace Google Cloud key" : "Connect Google Cloud"}</DialogTitle>
          <DialogDescription>Step {step} of 5. The key stays in this dialog and is not saved in the browser.</DialogDescription>
        </DialogHeader>
        {step === 1 ? (
          <div className="grid max-h-[50vh] gap-3 overflow-auto">
            <p className="text-sm text-muted-foreground">
              Create a service account named readmeter-reader and grant the read-only roles. The last two commands are
              only needed when you set a billing export table.
            </p>
            {commands.map((command) => (
              <div key={command} className="grid gap-1">
                <pre className="overflow-auto rounded-md bg-muted p-2 text-xs">{command}</pre>
                <CopyButton value={command} />
              </div>
            ))}
          </div>
        ) : null}
        {step === 2 ? (
          <div className="grid gap-2">
            <Label htmlFor="gcp-key">Service account JSON</Label>
            <Textarea
              id="gcp-key"
              data-testid="gcp-key"
              className="min-h-40 font-mono text-xs"
              value={jsonText}
              placeholder='Paste the JSON key. It must include type "service_account".'
              onChange={(event) => setJsonText(event.target.value)}
            />
            {jsonText.trim() && !parsed ? (
              <p className="text-sm text-destructive">JSON must be a service account with client_email, private_key, and project_id.</p>
            ) : null}
          </div>
        ) : null}
        {step === 3 ? (
          <div className="grid gap-2">
            <Label htmlFor="gcp-billing">Billing export table</Label>
            <Input
              id="gcp-billing"
              value={billingTable}
              placeholder="project.dataset.gcp_billing_export_v1"
              onChange={(event) => setBillingTable(event.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Optional. Use the standard usage cost export.{" "}
              <a className="underline" href={BILLING_DOCS} target="_blank" rel="noreferrer">
                Export Cloud Billing data to BigQuery
              </a>
            </p>
          </div>
        ) : null}
        {step === 4 ? (
          <div className="grid gap-2" data-testid="gcp-test-results">
            <p className="text-sm text-muted-foreground">Readmeter lists one Monitoring series and, if you set a table, dry-runs the billing query.</p>
            {checks?.map((check) => (
              <p key={check.name} className={check.ok ? "text-sm" : "text-sm text-destructive"}>
                {check.name}: {check.message}
              </p>
            ))}
          </div>
        ) : null}
        {step === 5 ? (
          <p className="text-sm">The key is stored. Usage and cost import on the next sync, usually within a minute.</p>
        ) : null}
        <DialogFooter>
          {step > 1 && step < 5 ? (
            <Button variant="outline" onClick={() => setStep((current) => current - 1)}>
              Back
            </Button>
          ) : null}
          {step < 4 ? (
            <Button
              onClick={() => setStep((current) => current + 1)}
              disabled={step === 2 && !parsed}
            >
              Continue
            </Button>
          ) : null}
          {step === 4 ? (
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              Run test
            </Button>
          ) : null}
          {step === 5 ? <Button onClick={() => close(false)}>Done</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function keyShape(text: string): boolean {
  try {
    const value = JSON.parse(text) as { type?: unknown; client_email?: unknown; private_key?: unknown; project_id?: unknown };
    return (
      value.type === "service_account" &&
      typeof value.client_email === "string" &&
      value.client_email.includes("@") &&
      typeof value.private_key === "string" &&
      value.private_key.length > 0 &&
      typeof value.project_id === "string" &&
      value.project_id.length > 0
    );
  } catch {
    return false;
  }
}
