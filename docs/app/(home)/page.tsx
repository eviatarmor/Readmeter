import Link from 'next/link';

const services = [
  'Cloud Firestore',
  'Realtime Database',
  'Cloud Storage',
  'Authentication',
  'Cloud Functions',
];

const links = [
  { title: 'Quickstart', href: '/docs/getting-started/quickstart', text: 'Run Readmeter locally against the Firebase emulators.' },
  { title: 'Add it to your app', href: '/docs/getting-started/your-app', text: 'Install the SDK in a Firebase web app and its Cloud Functions.' },
  { title: 'Rule reference', href: '/docs/rules', text: 'Every rule, its severity, thresholds and the fix.' },
  { title: 'Self-hosting', href: '/docs/self-hosting', text: 'Services, configuration and running it in production.' },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-16">
      <p className="text-sm font-medium text-fd-muted-foreground">Readmeter documentation</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
        Find what makes your Firebase bill grow, down to the line of code.
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground">
        A small SDK reports how your app calls Firebase. Rules find queries without limits,
        offset pagination, leaking listeners, repeated downloads and dozens of other patterns,
        and the console shows each one with its callsite and what it wasted.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/docs/getting-started/quickstart"
          className="rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
        >
          Get started
        </Link>
        <Link href="/docs" className="rounded-md border px-4 py-2 text-sm font-medium">
          Read the docs
        </Link>
      </div>
      <ul className="mt-8 flex flex-wrap gap-2 text-sm text-fd-muted-foreground">
        {services.map((service) => (
          <li key={service} className="rounded-full border px-3 py-1">
            {service}
          </li>
        ))}
      </ul>
      <div className="mt-14 grid gap-4 sm:grid-cols-2">
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="rounded-lg border p-5 transition-colors hover:bg-fd-accent">
            <h2 className="font-medium">{link.title}</h2>
            <p className="mt-1 text-sm text-fd-muted-foreground">{link.text}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
