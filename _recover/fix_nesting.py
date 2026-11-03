"""Hoist code blocks that were spliced INSIDE the previous block.

The reconstruction's characteristic injury is the same in every file: an insertion
whose recorded line number did not match the replay landed inside the preceding
function/method/function-body instead of after it, producing a construct that
cannot parse (`function` inside `function`, a statement after the closing brace of
a method, a CSS rule after a template literal closed).

This tool repairs one file at a time:

  * it finds every line that starts a declaration at indent 2 -- a method, or a
    top-level `function`/`export function` inside another function -- while the
    brace depth says it is nested deeper than its indent implies;
  * it cuts that block out and re-inserts it immediately after the block that
    currently encloses it;
  * it repeats until nothing is misplaced.

Depth is tracked over the whole file, so this only moves blocks; it never edits
their contents.
"""
import re
import sys
from pathlib import Path


def depths(lines):
    out, d = [], 0
    for l in lines:
        out.append(d)
        d += l.count("{") - l.count("}")
    return out


def block_end(lines, start):
    d, opened = 0, False
    for i in range(start, len(lines)):
        d += lines[i].count("{") - lines[i].count("}")
        if "{" in lines[i]:
            opened = True
        if opened and d <= 0:
            return i + 1
    return len(lines)


def repair(path, pat, expected_depth, max_rounds=40):
    p = Path(path)
    lines = p.open(encoding="utf-8", errors="replace").read().split("\n")
    moved_total = 0
    for _ in range(max_rounds):
        d = depths(lines)
        hit = None
        for i, l in enumerate(lines):
            if pat.match(l) and d[i] > expected_depth:
                hit = i
                break
        if hit is None:
            break
        end = block_end(lines, hit)
        block = lines[hit:end]
        owner = None
        for j in range(hit - 1, -1, -1):
            if d[j] == expected_depth and pat.match(lines[j]):
                owner = j
                break
        if owner is None:
            # no enclosing declaration found; leave it alone rather than guess
            break
        owner_end = block_end(lines, owner)
        rest = lines[:hit] + lines[end:]
        shift = end - hit
        new_owner_end = owner_end - shift if owner_end > hit else owner_end
        lines = rest[:new_owner_end] + block + rest[new_owner_end:]
        moved_total += 1
    p.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8", newline="")
    d = depths(lines)
    left = sum(1 for i, l in enumerate(lines) if pat.match(l) and d[i] > expected_depth)
    print(f"{path}: moved {moved_total} blocks, {left} still nested, {len(lines)} lines")


if __name__ == "__main__":
    target = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    pattern = sys.argv[3] if len(sys.argv) > 3 else r"^  (?:(?:private|public|protected|static) )?(?:async )?(\w+)\s*\("
    repair(target, re.compile(pattern), depth)
