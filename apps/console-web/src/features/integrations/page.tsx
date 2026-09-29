import { Link } from "@tanstack/react-router";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DOCS_URL } from "@/components/shell/nav";
import type { WorkspaceSearch } from "@/lib/workspace-search";

export function IntegrationsPage({ slug, search }: { slug: string; search: WorkspaceSearch }) {
  return (
    <div className="grid gap-4">
      <PageHeader title="Integrations" description="Send telemetry with the SDK today. Billing import is next." />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            Google Cloud
            <Badge variant="outline">Coming soon</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-muted-foreground">
          <p>Invoice import is not connected, so cost pages stay on the estimate from the price catalog.</p>
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
