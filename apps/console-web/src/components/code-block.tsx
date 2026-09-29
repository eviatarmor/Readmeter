import { useTheme } from "next-themes";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const langMap: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
};

const highlighterPromise = import("shiki").then(({ createHighlighter }) =>
  createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: ["typescript", "tsx", "javascript", "jsx", "json"],
  }),
);

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = React.useState<string | null>(null);
  const language = langMap[lang] ?? lang;
  const theme = resolvedTheme === "dark" ? "github-dark" : "github-light";

  React.useEffect(() => {
    let cancelled = false;
    void highlight(code, language, theme).then((value) => {
      if (!cancelled) setHtml(value);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  if (!html) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="overflow-auto rounded-lg border bg-muted/40 text-xs [&_pre]:p-3">
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

async function highlight(code: string, lang: string, theme: "github-light" | "github-dark"): Promise<string> {
  const highlighter = await highlighterPromise;
  const loaded = highlighter.getLoadedLanguages();
  if (!loaded.includes(lang)) {
    await highlighter.loadLanguage(lang as "typescript");
  }
  return highlighter.codeToHtml(code, { lang, theme });
}
