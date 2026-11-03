"""Repair the three recurring injuries left in the reconstructed source.

Every one of these is visible to the compiler and has an unambiguous fix, so the
tool applies them one at a time and keeps a change only when the error count for
that file goes DOWN. That makes it safe to run repeatedly: a wrong guess is
reverted instead of accumulated.

Injury A -- duplicated opener. Two identical `  x: {` / `  x(` lines in a row:
  the same opening line was applied twice.

Injury B -- duplicated identifier line. Two identical `    <word>: <type>` field
  lines where a single declaration was doubled.

Injury C -- a whole method or const block spliced inside the block above it, so it
  sits at a brace depth deeper than its own indentation implies. Hoisting it after
  the enclosing block restores the structure.
"""
import re
import subprocess
import sys
from pathlib import Path

TREE = Path(r"W:\dsh-plugins\dsh-rtt-debug")
NODE = r"W:\DeepSeek Harness\HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
TSC = str(TREE / "node_modules" / "typescript" / "bin" / "tsc")


def errors_for(rel):
    r = subprocess.run([NODE, TSC, "--noEmit"], cwd=TREE, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    n = 0
    for line in (r.stdout or "").splitlines():
        if line.strip().startswith(rel):
            n += 1
    return n


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


def injury_a(lines):
    """Adjacent identical lines that open a block."""
    for i in range(1, len(lines)):
        if lines[i] == lines[i - 1] and lines[i].strip().endswith("{"):
            return i
    return None


def injury_b(lines):
    """Adjacent identical field/assignment lines."""
    for i in range(1, len(lines)):
        if lines[i] == lines[i - 1] and re.match(r"^\s+\w+\??:\s*\S", lines[i]):
            return i
    return None


METHOD = re.compile(r"^(\s*)(?:(?:private|public|protected|static) )?(?:async )?\w+\s*\(")


def injury_c(lines):
    """A method/function block nested deeper than its indentation implies."""
    d = depths(lines)
    for i, l in enumerate(lines):
        m = METHOD.match(l)
        if not m:
            continue
        indent = len(m.group(1))
        # class members sit at depth 1 with indent 2; assume depth <= indent/2 + 1
        if indent and d[i] > (indent // 2) + 1:
            return i
    return None


def repair(rel, max_steps=400):
    path = TREE / rel
    best = path.open(encoding="utf-8", errors="replace").read()
    best_err = errors_for(rel)
    print(f"{rel}: starting at {best_err} errors")
    if best_err == 0:
        return best_err

    for step in range(max_steps):
        lines = best.split("\n")
        did = False

        # A then B then C, each as a single reversible edit
        idx = injury_a(lines)
        if idx is not None:
            cand = lines[:idx] + lines[idx + 1:]
        else:
            idx = injury_b(lines)
            if idx is not None:
                cand = lines[:idx] + lines[idx + 1:]
            else:
                idx = injury_c(lines)
                if idx is None:
                    break
                i = idx
                end = block_end(lines, i)
                block = lines[i:end]
                d = depths(lines)
                owner = None
                for j in range(i - 1, -1, -1):
                    m = METHOD.match(lines[j])
                    if m and len(m.group(1)) == len(METHOD.match(lines[i]).group(1)) and d[j] <= (len(m.group(1)) // 2) + 1:
                        owner = j
                        break
                if owner is None:
                    break
                owner_end = block_end(lines, owner)
                rest = lines[:i] + lines[end:]
                shift = end - i
                new_owner_end = owner_end - shift if owner_end > i else owner_end
                cand = rest[:new_owner_end] + block + rest[new_owner_end:]

        text = "\n".join(cand)
        path.write_text(text, encoding="utf-8", newline="")
        err = errors_for(rel)
        if err < best_err:
            best, best_err, did = text, err, True
        else:
            path.write_text(best, encoding="utf-8", newline="")
        if not did:
            break
        if step % 10 == 0:
            print(f"  step {step}: {best_err} errors")

    path.write_text(best, encoding="utf-8", newline="")
    print(f"{rel}: finished at {best_err} errors")
    return best_err


if __name__ == "__main__":
    for rel in sys.argv[1:]:
        repair(rel)
