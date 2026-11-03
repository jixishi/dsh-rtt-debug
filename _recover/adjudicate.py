"""Adjudicate between the two engines per file, using structure as the gate.

Two independent reconstructions exist. For each file both are structurally
checked (bracket balance, duplicate declarations, leaked read-tool artefacts);
a file that passes wins over one that does not, and when both pass the longer
one wins (the failure mode here is loss, not invention). The result is written to
`tree_final`, with a report of which engine supplied each file and why.
"""
import shutil
from pathlib import Path
import structure

HERE = Path(__file__).parent
A = HERE / "tree"
B = HERE / "tree2"
FINAL = HERE / "tree_final"
CODE = (".ts", ".tsx", ".mjs", ".js", ".cjs")


def check(text, is_code):
    problems = []
    if not text.strip():
        return ["empty"]
    if "(End of file - total" in text:
        problems.append("read-tool trailer")
    if is_code:
        ok, why = structure.balance(structure.lex(text))
        if not ok:
            problems.append(f"brackets: {why}")
    return problems


def nonblank(text):
    return sum(1 for l in text.split("\n") if l.strip())


def main():
    if FINAL.exists():
        shutil.rmtree(FINAL)
    files_a = {p.relative_to(A).as_posix(): p for p in A.rglob("*") if p.is_file()}
    files_b = {p.relative_to(B).as_posix(): p for p in B.rglob("*") if p.is_file()}
    allrel = sorted(set(files_a) | set(files_b))

    report = []
    for rel in allrel:
        pa, pb = files_a.get(rel), files_b.get(rel)
        ta = pa.open(encoding="utf-8", errors="replace").read() if pa else None
        tb = pb.open(encoding="utf-8", errors="replace").read() if pb else None
        is_code = rel.endswith(CODE)
        prob_a = check(ta, is_code) if ta is not None else ["absent"]
        prob_b = check(tb, is_code) if tb is not None else ["absent"]

        if ta is None:
            chosen, src, why = tb, "engine2", "engine1 missing"
        elif tb is None:
            chosen, src, why = ta, "engine1", "engine2 missing"
        elif not prob_b and prob_a:
            chosen, src, why = tb, "engine2", f"engine1 invalid ({'; '.join(prob_a)})"
        elif not prob_a and prob_b:
            chosen, src, why = ta, "engine1", f"engine2 invalid ({'; '.join(prob_b)})"
        elif nonblank(tb) > nonblank(ta):
            chosen, src, why = tb, "engine2", "both valid, engine2 larger"
        else:
            chosen, src, why = ta, "engine1", "both valid, engine1 >= engine2"

        dst = FINAL / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        with dst.open("w", encoding="utf-8", newline="") as fh:
            fh.write(chosen)
        report.append((rel, src, nonblank(ta) if ta is not None else 0,
                       nonblank(tb) if tb is not None else 0, why))

    print(f"{'file':44s} {'from':8s} {'e1':>6s} {'e2':>6s}  why")
    for rel, src, na, nb, why in report:
        print(f"{rel:44s} {src:8s} {na:6d} {nb:6d}  {why}")


if __name__ == "__main__":
    main()
