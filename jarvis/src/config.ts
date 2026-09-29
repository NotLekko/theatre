import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_MODEL = "claude-opus-5-5";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface Location {
  city?: string;
  region?: string;
  country?: string;
  timezone: string;
}

export interface Config {
  model: string;
  effort: Effort;
  voice: boolean;
  voiceName: string | undefined;
  honorific: string;
  userName: string | undefined;
  home: string;
  fastBoot: boolean;
  location: Location;
}

export interface CliOptions {
  config: Config;
  /** A one-shot request passed on the command line; JARVIS answers it and exits. */
  prompt: string | undefined;
  help: boolean;
}

export const USAGE = `J.A.R.V.I.S. - Just A Rather Very Intelligent System

Usage:
  npm start                         start an interactive session
  npm start -- "what time is it?"   answer one request and exit

Options:
  --no-voice         keep quiet (text only)
  --effort <level>   thinking effort: ${EFFORT_LEVELS.join(", ")} (default: medium)
  --model <id>       Claude model id (default: ${DEFAULT_MODEL})
  --fast             skip the boot animation
  -h, --help         show this help

Environment:
  ANTHROPIC_API_KEY  your Claude API key (or sign in with \`ant auth login\`)
  JARVIS_HONORIFIC   how JARVIS addresses you (default: sir)
  JARVIS_USER_NAME   your name
  JARVIS_VOICE       set to "off" to disable speech by default
  JARVIS_VOICE_NAME  text-to-speech voice (e.g. Daniel on macOS, en-gb on espeak)
  JARVIS_EFFORT      default thinking effort
  JARVIS_MODEL       default model id
  JARVIS_HOME        where memories are stored (default: ~/.jarvis)
  JARVIS_CITY, JARVIS_REGION, JARVIS_COUNTRY
                     your approximate location, for local search results
                     (country is a two-letter code such as GB or US)`;

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      voice: { type: "boolean" },
      fast: { type: "boolean" },
      effort: { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    allowNegative: true,
  });

  const effort = values.effort ?? env.JARVIS_EFFORT ?? "medium";
  if (!isEffort(effort)) {
    throw new Error(`Unknown effort level "${effort}". Use one of: ${EFFORT_LEVELS.join(", ")}.`);
  }
  const voiceSetting = env.JARVIS_VOICE?.trim().toLowerCase();
  const voiceOffInEnv = voiceSetting === "off" || voiceSetting === "0" || voiceSetting === "false";

  return {
    help: values.help ?? false,
    prompt: positionals.length > 0 ? positionals.join(" ") : undefined,
    config: {
      model: values.model ?? env.JARVIS_MODEL ?? DEFAULT_MODEL,
      effort,
      voice: values.voice ?? !voiceOffInEnv,
      voiceName: env.JARVIS_VOICE_NAME || undefined,
      honorific: env.JARVIS_HONORIFIC || "sir",
      userName: env.JARVIS_USER_NAME || undefined,
      home: env.JARVIS_HOME || path.join(os.homedir(), ".jarvis"),
      fastBoot: values.fast ?? false,
      location: {
        city: env.JARVIS_CITY || undefined,
        region: env.JARVIS_REGION || undefined,
        country: env.JARVIS_COUNTRY || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
  };
}
