"""Second reconstruction engine: latest-full-snapshot base + later events only.

The replay engine starts from the file's first write and has to survive every
edit of a month-long, multi-agent history. This engine starts from the newest
WHOLE-FILE read of each file -- real disk content, no inference -- and applies
only the events that happened after that snapshot. It is much shorter-lived, so
it has far less room to drift, and it is independent enough that agreeing with
the replay is meaningful evidence.
"""
import json
from pathlib import Path
import rebuild

OUT2 = rebuild.HERE / "tree2"


def main():
    events = rebuild.load_events()

    # newest full snapshot per file (by time), preferring the largest content
    best = {}
    for time, seq, sid, kind, args in events:
        if kind != "read":
            continue
        rel, rows, total, _cid = args
        if rows[0][0] != 1 or rows[-1][0] < total:
            continue
        body = "\n".join(t for _, t in rows) + "\n"
        prev = best.get(rel)
        if prev is None or time >= prev[0]:
            best[rel] = (time, body)

    state = {rel: body for rel, (t, body) in best.items()}
    cutoff = {rel: t for rel, (t, _b) in best.items()}

    st = dict(applied=0, skipped_before_base=0)
    for time, seq, sid, kind, args in events:
        if kind == "read":
            continue
        name, cargs, reviews = args
        if reviews:
            for rel, diffs in reviews:
                if not diffs:
                    continue
                if rel in cutoff and time <= cutoff[rel]:
                    st["skipped_before_base"] += 1
                    continue
                before = state.get(rel)
                if before is None:
                    continue
                state[rel], _ = rebuild.apply_diff_lines(before, diffs)
                st["applied"] += 1
            continue
        rel = rebuild.norm(cargs.get("file_path"))
        if rel is None:
            continue
        if rel in cutoff and time <= cutoff[rel]:
            st["skipped_before_base"] += 1
            continue
        if name == "write":
            state[rel] = cargs.get("content") or ""
            st["applied"] += 1
            continue
        cur = state.get(rel)
        if cur is None:
            continue
        old = cargs.get("old_string") or ""
        new = cargs.get("new_string") or ""
        if cur.count(old) == 1:
            state[rel] = cur.replace(old, new)
        elif cur.count(old) > 1 and cargs.get("replace_all"):
            state[rel] = cur.replace(old, new)
        else:
            continue
        st["applied"] += 1

    for rel, content in sorted(state.items()):
        dst = OUT2 / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        with dst.open("w", encoding="utf-8", newline="") as fh:
            fh.write(content)

    print(f"engine2 wrote {len(state)} files -> {OUT2}")
    for k, v in st.items():
        print(f"  {k:22s} {v}")


if __name__ == "__main__":
    main()
