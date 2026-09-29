import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthConfig } from "@/features/session/queries";
import { authClient } from "@/lib/auth-client";

export function SignInPage({ next }: { next?: string }) {
  const navigate = useNavigate();
  const config = useAuthConfig();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    const result = await authClient.signIn.email({ email, password });
    setPending(false);
    if (result.error) {
      toast.error(result.error.message ?? "Could not sign in");
      return;
    }
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      window.location.assign(next);
      return;
    }
    await navigate({ to: "/" });
  }

  return (
    <AuthCard title="Sign in" description="Use the workspace account for this console.">
      <form className="grid gap-3" onSubmit={(event) => void onSubmit(event)}>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <Button type="submit" disabled={pending}>
          Sign in
        </Button>
      </form>
      {config.data?.google ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: next ?? "/" })}
        >
          Continue with Google
        </Button>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <Link to="/forgot-password" className="underline">
          Forgot password
        </Link>
        {" · "}
        <Link to="/sign-up" className="underline">
          Create an account
        </Link>
      </p>
    </AuthCard>
  );
}

export function SignUpPage() {
  const navigate = useNavigate();
  const config = useAuthConfig();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = await authClient.signUp.email({ name, email, password });
    if (result.error) {
      toast.error(result.error.message ?? "Could not create the account");
      return;
    }
    await navigate({ to: "/onboarding" });
  }

  return (
    <AuthCard title="Create account" description="Password must be at least 10 characters.">
      <form className="grid gap-3" onSubmit={(event) => void onSubmit(event)}>
        <Label htmlFor="name">Name</Label>
        <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required />
        <Button type="submit">Create account</Button>
      </form>
      {config.data?.google ? (
        <Button type="button" variant="outline" onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: "/onboarding" })}>
          Continue with Google
        </Button>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <Link to="/sign-in" search={{ next: undefined }} className="underline">
          Already have an account
        </Link>
      </p>
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [resetLink, setResetLink] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/auth/request-password-reset", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, redirectTo: `${window.location.origin}/reset-password` }),
    });
    const payload = (await response.json().catch(() => null)) as { resetLink?: string; message?: string } | null;
    if (!response.ok) {
      toast.error(payload?.message ?? "Could not send the reset email");
      return;
    }
    setResetLink(payload?.resetLink ?? null);
    toast.success(payload?.resetLink ? "Reset link ready" : "Check your email");
  }

  return (
    <AuthCard title="Reset password" description="We will email a link if this address has an account.">
      <form className="grid gap-3" onSubmit={(event) => void onSubmit(event)}>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Button type="submit">Send reset link</Button>
      </form>
      {resetLink ? (
        <a href={resetLink} className="break-all text-sm underline">
          {resetLink}
        </a>
      ) : null}
    </AuthCard>
  );
}

export function ResetPasswordPage({ token }: { token: string }) {
  const navigate = useNavigate();
  const [password, setPassword] = React.useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) {
      toast.error(result.error.message ?? "Could not reset the password");
      return;
    }
    toast.success("Password updated");
    await navigate({ to: "/sign-in", search: { next: undefined } });
  }

  return (
    <AuthCard title="Choose a new password" description="Use at least 10 characters.">
      <form className="grid gap-3" onSubmit={(event) => void onSubmit(event)}>
        <Label htmlFor="password">New password</Label>
        <Input id="password" type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required />
        <Button type="submit" disabled={token.length === 0}>
          Update password
        </Button>
      </form>
    </AuthCard>
  );
}

export function AcceptInvitePage({ invitationId }: { invitationId: string }) {
  const navigate = useNavigate();
  const [message, setMessage] = React.useState("Accepting invitation…");

  React.useEffect(() => {
    void authClient.organization.acceptInvitation({ invitationId }).then(async (result) => {
      if (result.error) {
        setMessage(result.error.message ?? "Could not accept the invitation");
        return;
      }
      await navigate({ to: "/" });
    });
  }, [invitationId, navigate]);

  return (
    <AuthCard title="Invitation" description={message}>
      <Button asChild variant="outline">
        <Link to="/sign-in" search={{ next: `/accept-invitation/${invitationId}` }}>
          Sign in
        </Link>
      </Button>
    </AuthCard>
  );
}

function AuthCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Logo />
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">{children}</CardContent>
      </Card>
    </div>
  );
}
