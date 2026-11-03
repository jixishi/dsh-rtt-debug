"""Structural acceptance gate for the reconstruction.

No TypeScript compiler is installed, so parsing cannot prove the rebuild. What
CAN be checked objectively:

  * bracket balance -- a splice injury almost always leaves an unbalanced
    `{}` / `()` / `[]`;
  * duplicate top-level declarations -- a diff applied to the wrong occurrence
    shows up as the same `export function x` twice;
  * literal splice markers -- the read tool's trailer or line-number prefixes
    leaking into a source file;
  * empty/truncated files.

The lexer below understands line comments, block comments, quoted strings,
template literals WITH `${}` interpolation (recursively) and regex literals --
without those, ordinary code reports as unbalanced and the gate is worthless.
"""
import re
from pathlib import Path
from collections import Counter

TREE = Path(r"W:\dsh-plugins\dsh-rtt-debug\_recover\tree")
CODE = (".ts", ".tsx", ".mjs", ".js")

# A `/` in one of these left-hand contexts starts a regex literal, not division.
REGEX_PREV = set("(,=:[!&|?{};+-*%~^<>")
REGEX_WORDS = {"return", "typeof", "instanceof", "in", "of", "new", "delete",
               "void", "case", "do", "else", "yield", "await"}


def lex(text):
    """Yield only the structural characters outside literals and comments."""
    out = []
    i, n = 0, len(text)
    last_significant = "\n"

    def prev_word():
        j = len(out) - 1
        while j >= 0 and out[j].isspace():
            j -= 1
        k = j
        while k >= 0 and (out[k].isalnum() or out[k] in "_$"):
            k -= 1
        return "".join(out[k + 1:j + 1])

    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"":
            q = c
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == q:
                    i += 1
                    break
                if text[i] == "\n":      # unterminated: bail
                    break
                i += 1
            last_significant = q
            continue
        if c == "`":
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == "`":
                    i += 1
                    break
                if text.startswith("${", i):
                    # interpolation is code again
                    i += 2
                    depth = 1
                    while i < n and depth:
                        if text[i] == "{":
                            depth += 1
                        elif text[i] == "}":
                            depth -= 1
                        i += 1
                    continue
                i += 1
            last_significant = "`"
            continue
        if c == "/":
            word = prev_word()
            if last_significant in REGEX_PREV or word in REGEX_WORDS or last_significant == "\n":
                i += 1
                in_class = False
                while i < n:
                    if text[i] == "\\":
                        i += 2
                        continue
                    if text[i] == "[":
                        in_class = True
                    elif text[i] == "]":
                        in_class = False
                    elif text[i] == "/" and not in_class:
                        i += 1
                        break
                    elif text[i] == "\n":
                        break
                    i += 1
                while i < n and (text[i].isalpha()):
                    i += 1
                last_significant = "/"
                continue
        if not c.isspace():
            last_significant = c
        out.append(c)
        i += 1
    return "".join(out)


def balance(text):
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    for ch in text:
        if ch in "([{":
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack[-1] != pairs[ch]:
                return False, f"unexpected {ch!r}"
            stack.pop()
    if stack:
        return False, f"{len(stack)} unclosed {''.join(stack[-4:])!r}"
    return True, ""


issues = []
checked = 0
for p in sorted(TREE.rglob("*")):
    if not p.is_file() or p.suffix not in CODE:
        continue
    checked += 1
    raw = p.open(encoding="utf-8", errors="replace").read()
    rel = p.relative_to(TREE)

    if not raw.strip():
        issues.append((rel, "empty file"))
        continue

    ok, why = balance(lex(raw))
    if not ok:
        issues.append((rel, f"unbalanced brackets: {why}"))

    if "(End of file - total" in raw:
        issues.append((rel, "read-tool trailer leaked in"))
    if re.search(r"^\s*\d+: ", raw, re.M):
        issues.append((rel, "line-number prefixes leaked in"))

    decls = re.findall(r"^export (?:async )?(?:function|class|const|interface|type)\s+(\w+)", raw, re.M)
    dupes = [name for name, n in Counter(decls).items() if n > 1]
    if dupes:
        issues.append((rel, f"duplicate declarations: {', '.join(dupes[:4])}"))

print(f"checked {checked} code files\n")
if not issues:
    print("no structural issues found")
for rel, msg in issues:
    print(f"  {rel}\n      {msg}")
