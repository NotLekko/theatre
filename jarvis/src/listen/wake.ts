// Speech recognizers render "Hey JARVIS" many ways: "Hey, Jarvis.", "Hi Jarvis", "Okay Jervis"...
// The greeting must open the utterance (after at most two filler words such as "uh" or
// "so"), so merely mentioning Jarvis in conversation doesn't wake him.
const WAKE_PHRASE = /^\W*(?:[\w']+\W+){0,2}?(?:hey|hay|hi|ok|okay)\W+j[ae]r?v[aeiou]?s(?:'s)?\b[\W_]*/i;

export interface WakeMatch {
  /** Whatever followed the wake phrase in the same breath; empty if nothing did. */
  command: string;
}

export function matchWakePhrase(transcript: string): WakeMatch | null {
  const text = transcript.trim();
  const match = WAKE_PHRASE.exec(text);
  if (!match) return null;
  const rest = text.slice(match[0].length).trim();
  return { command: rest && !/\w/.test(rest) ? "" : rest.charAt(0).toUpperCase() + rest.slice(1) };
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
