"""Engine 3: anchor on the LARGEST observed snapshot, apply only clean diffs after it.

Why this exists: the replay engines can inflate a file. service.ts was observed at
most at 540 lines, yet replay produced 810 -- the difference is duplicated blocks,
not real code. That is detectable: a reconstruction longer than any version ever
read cannot be right.

So the base is not "first write" and not "newest snapshot" but the snapshot with the
largest line total, which is the most complete state anyone actually saw on disk.
Diffs recorded after that snapshot are then applied, and a diff is applied only if
EVERY hunk lands -- a partial application is what corrupts a file.
"""
import json
from pathlib import Path
import rebuild

OUT3 = rebuild.HERE / "tree3"


def main():
    events = rebuild.load_events()

    # largest whole-file snapshot per file, by line total then by time
    best = {}
    for time, seq, sid, kind, args in events:
        if kind != "read":
            continue
        rel, rows, total, _cid = args
        if rows[0][0] != 1 or rows[-1][0] < total:
            continue
        key = (total, time)
        prev = best.get(rel)
        if prev is None or key >= prev[0]:
            best[rel] = (key, "\n".join(t for _, t in rows) + "\n")

    state = {rel: body for rel, (_k, body) in best.items()}
    base_total = {rel: k[0] for rel, (k, _b) in best.items()}
    base_time = {rel: k[1] for rel, (k, _b) in best.items()}

    st = dict(clean=0, skipped_partial=0, skipped_edit=0, grew_beyond_base=0)
    grew = {}

    for time, seq, sid, kind, args in events:
        if kind == "read":
            continue
        name, cargs, reviews = args
        if reviews:
            for rel, diffs in reviews:
                if not diffs or rel not in state:
                    continue
                if rel in base_time and time <= base_time[rel]:
                    continue
                before = state[rel]
                after, frozen = rebuild.apply_diff_lines(before, diffs)
                # A partial application means some hunk's anchor was missing in
                # this version; refuse the whole diff instead of half-applying.
                if frozen:
                    st["skipped_partial"] += 1
                    continue
                state[rel] = after
                st["clean"] += 1
                grew[rel] = grew.get(rel, 0) + 1
            continue
        rel = rebuild.norm(cargs.get("file_path"))
        if rel is None:
            continue
        if rel in base_time and time <= base_time[rel]:
            continue
        if name == "write":
            state[rel] = cargs.get("content") or ""
            st["clean"] += 1
            continue
        cur = state.get(rel)
        if cur is None:
            continue
        old = cargs.get("old_string") or ""
        new = cargs.get("new_string") or ""
        if cur.count(old) == 1:
            state[rel] = cur.replace(old, new)
            st["clean"] += 1
        elif cur.count(old) > 1 and cargs.get("replace_all"):
            state[rel] = cur.replace(old, new)
            st["clean"] += 1
        else:
            st["skipped_edit"] += 1

    for rel, content in sorted(state.items()):
        dst = OUT3 / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        with dst.open("w", encoding="utf-8", newline="") as fh:
            fh.write(content)

    print(f"engine3 wrote {len(state)} files -> {OUT3}")
    for k, v in st.items():
        print(f"  {k:20s} {v}")
    # report where the result still exceeds the largest version ever read
    print("\nfiles exceeding their largest observed version:")
    any_over = False
    for rel, content in sorted(state.items()):
        n = content.rstrip("\n").count("\n") + 1
        base = base_total.get(rel)
        if base and n > base:
            print(f"  {rel:40s} {n} > {base}")
            any_over = True
    if not any_over:
        print("  none")


if __name__ == "__main__":
    main()
