#!/usr/bin/env tsx
import { connect } from "@readmeter/db";

import { run } from "./commands.ts";
import { parseArgs, USAGE, UsageError } from "./parse.ts";

let command;
try {
  command = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof UsageError) console.error(USAGE);
  process.exit(1);
}

const { db, close } = connect();
try {
  const text = await run(db, command);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await close();
}
