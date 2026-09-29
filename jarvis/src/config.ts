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
  /** Listen for "Hey JARVIS" from the start. */
  listen: boolean;
  /** Microphone device index for PvRecorder; -1 is the system default. */
  micDevice: number;
  /** Serve the HUD in a browser instead of using the terminal. */
  web: boolean;
  port: number;
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
  npm run web                       open the HUD in your browser

Options:
  --no-voice         keep quiet (text only)
  --listen           listen for "Hey JARVIS" (speech is recognized on this machine)
  --effort <level>   thinking effort: ${EFFORT_LEVELS.join(", ")} (default: medium)
  --model <id>       Claude model id (default: ${DEFAULT_MODEL})
  --fast             skip the boot animation
  --web              serve the HUD at http://127.0.0.1:4242 instead of using the terminal
  --port <number>    port for --web (default: 4242)
  -h, --help         show this help

Environment:
  ANTHROPIC_API_KEY  your Claude API key (or sign in with \`ant auth login\`)
  JARVIS_HONORIFIC   how JARVIS addresses you (default: sir)
  JARVIS_USER_NAME   your name
  JARVIS_VOICE       set to "off" to disable speech by default
  JARVIS_VOICE_NAME  text-to-speech voice (e.g. Daniel on macOS, en-gb on espeak)
  JARVIS_LISTEN      set to "on" to listen for "Hey JARVIS" by default
  JARVIS_MIC_DEVICE  microphone device index (default: the system default)
  JARVIS_PORT        port for --web (default: 4242)
  JARVIS_EFFORT      default thinking effort
  JARVIS_MODEL       default model id
  JARVIS_HOME        where memories and speech models are stored (default: ~/.jarvis)
  JARVIS_CITY, JARVIS_REGION, JARVIS_COUNTRY
                     your approximate location, for local search results
                     (country is a two-letter code such as GB or US)`;

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      voice: { type: "boolean" },
      listen: { type: "boolean" },
      web: { type: "boolean" },
      port: { type: "string" },
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
  const listenSetting = env.JARVIS_LISTEN?.trim().toLowerCase();
  const listenOnInEnv = listenSetting === "on" || listenSetting === "1" || listenSetting === "true";
  const port = Number(values.port ?? env.JARVIS_PORT ?? 4242);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`The port must be a number from 0 to 65535, not "${values.port ?? env.JARVIS_PORT}".`);
  }
  const micDevice = env.JARVIS_MIC_DEVICE?.trim() ? Number(env.JARVIS_MIC_DEVICE) : -1;
  if (!Number.isInteger(micDevice) || micDevice < -1) {
    throw new Error(`JARVIS_MIC_DEVICE must be a device index (0, 1, ...), not "${env.JARVIS_MIC_DEVICE}".`);
  }

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
      listen: values.listen ?? listenOnInEnv,
      micDevice,
      web: values.web ?? false,
      port,
      location: {
        city: env.JARVIS_CITY || undefined,
        region: env.JARVIS_REGION || undefined,
        country: env.JARVIS_COUNTRY || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
  };
}
