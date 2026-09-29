#!/usr/bin/env python3
"""Estimate voiceover length for every script in faceless-tiktok/scripts/.

Creator Rewards only pays on videos over 60 seconds, and AI voices sped up to
1.05-1.1x read faster than you think, so each script should estimate at
64-85 seconds at our 170 wpm casting pace.

Conventions (see 03-content-playbook.md → Script format):
  - each script starts with a "## " heading
  - spoken lines start with "> " under a "### Voiceover" heading
  - *(stage directions)* inside a voiceover line are not counted

    python3 faceless-tiktok/tools/script_length.py [file.md ...]
"""

import pathlib
import re
import sys

WPM = 170
MIN_SECONDS = 64
MAX_SECONDS = 85

STAGE_DIRECTION = re.compile(r"\*\([^)]*\)\*")


def parse(path):
    """Yield (title, spoken_word_count) for each script in a markdown file."""
    title, words, in_voiceover = None, 0, False
    for line in path.read_text().splitlines():
        if line.startswith("## "):
            if title:
                yield title, words
            title, words, in_voiceover = line[3:].strip(), 0, False
        elif line.startswith("### "):
            in_voiceover = line[4:].strip().lower() == "voiceover"
        elif title and in_voiceover and line.startswith(">"):
            spoken = STAGE_DIRECTION.sub("", line.lstrip("> "))
            words += len(spoken.split())
    if title:
        yield title, words


def main(argv):
    root = pathlib.Path(__file__).resolve().parent.parent / "scripts"
    files = [pathlib.Path(a) for a in argv] or sorted(root.glob("*.md"))

    failures = 0
    for path in files:
        for title, words in parse(path):
            seconds = words / WPM * 60
            if seconds < MIN_SECONDS:
                status = "TOO SHORT: add a step or a bonus tip"
                failures += 1
            elif seconds > MAX_SECONDS:
                status = "LONG: trim the stakes or the demo"
                failures += 1
            else:
                status = "ok"
            print(f"{title[:48]:<48} {words:>4} words  ~{seconds:>3.0f}s  {status}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
