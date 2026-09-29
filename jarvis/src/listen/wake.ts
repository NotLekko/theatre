// Speech recognizers render "Hey JARVIS" many ways: "Hey, Jarvis.", "Hi Jarvis", "Okay Jervis"...
const GREETING_AND_NAME = String.raw`(?:hey|hay|hi|ok|okay)\W+j[ae]r?v[aeiou]?s(?:'s)?\b[\W_]*`;

// Normally the greeting must open the utterance (after at most two filler words such as
// "uh" or "so"), so merely mentioning Jarvis in conversation doesn't wake him.
const WAKE_PHRASE = new RegExp(String.raw`^\W*(?:[\w']+\W+){0,2}?` + GREETING_AND_NAME, "i");
// When he's talking over you, the transcript also holds his own words, so look anywhere.
const WAKE_PHRASE_ANYWHERE = new RegExp(String.raw`\b` + GREETING_AND_NAME, "i");

export interface WakeMatch {
  /** Whatever followed the wake phrase in the same breath; empty if nothing did. */
  command: string;
}

function tidy(rest: string): string {
  const text = rest.trim();
  if (!/\w/.test(text)) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function matchWakePhrase(transcript: string): WakeMatch | null {
  const text = transcript.trim();
  const match = WAKE_PHRASE.exec(text);
  return match ? { command: tidy(text.slice(match[0].length)) } : null;
}

export function findWakePhrase(transcript: string): WakeMatch | null {
  const match = WAKE_PHRASE_ANYWHERE.exec(transcript);
  return match ? { command: tidy(transcript.slice(match.index + match[0].length)) } : null;
}

const STOP_REQUEST = new RegExp(
  String.raw`^(?:please )?(?:stop(?: talking| it| that)?|shut up|be quiet|quiet|hush|shush|silence|enough|` +
    String.raw`that's enough|that is enough|never ?mind|cancel(?: that)?|forget it|nothing|` +
    String.raw`that'll be all|that will be all|thanks|thank you|no thanks|no thank you)` +
    String.raw`(?: (?:please|thanks|thank you|jarvis|sir|now))*$`,
);

/** Whether a spoken request only asks JARVIS to stop (or not to bother). */
export function isStopRequest(command: string): boolean {
  const text = command.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  return STOP_REQUEST.test(text);
}

export type Confirmation = "yes" | "no" | "always";

/** Interprets a spoken answer to "Shall I proceed?". Anything unclear counts as no. */
export function parseConfirmation(answer: string): Confirmation {
  const text = answer.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(always|every time|don't ask|stop asking)\b/.test(text) && !/^(no|nope|nah)\b/.test(text)) return "always";
  if (/\b(no|nope|nah|negative|cancel|abort)\b|\b(don't|do not)\b(?! ask)|\bstop\b(?! asking)/.test(text)) return "no";
  const yes = /^(?:[a-z']+ )?(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|proceed|affirmative|please|absolutely|of course|fine|run it)\b/;
  return yes.test(text) ? "yes" : "no";
}
