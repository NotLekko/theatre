import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE, loadConfig, type CliOptions } from "./config.ts";
import { color } from "./hud.ts";
import { runTerminal } from "./terminal.ts";
import { runWeb } from "./web.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(appDir, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function parseCli(): CliOptions | undefined {
  try {
    return loadConfig(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return undefined;
  }
}

async function main(): Promise<void> {
  const cli = parseCli();
  if (!cli) return;
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  if (cli.config.web) await runWeb(cli.config, cli.config.port);
  else await runTerminal(cli.config, cli.prompt);
}

main().catch((err: unknown) => {
  console.error(color.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
