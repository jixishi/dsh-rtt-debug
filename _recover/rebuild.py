"""Rebuild the dsh-rtt-debug tree from the strongest evidence in the logs.

Evidence ladder, strongest first:

  1. `dshFileReview` diffs on tool results. Every applied edit/write returns the
     exact `oldText` and `newText` that landed on disk, with line numbers
     (`oldStart`/`newStart`). This is ground truth for what happened, including
     edits whose call arguments no longer match the reconstructed text.
  2. `read` snapshots (meta.lines): ground truth for a whole file, or a line
     range of one, at the moment it was read.
  3. `write` call arguments: the intended content of a new file.
  4. `edit` call arguments: the intended change, used only when no diff exists.

Replay notes that matter for fidelity:
  * Sessions FORK. A continuation session re-records its parent's tool calls
    (two November logs share 720 identical calls), so one event per callId.
  * A call can be REJECTED (stale old_string, ambiguous match, file changed).
    Rejected calls never touched the disk and must not be replayed.
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "tree"
ROOT_MARK = "dsh-plugins\\dsh-rtt-debug"


def norm(p):
    p = (p or "").replace("/", "\\")
    low = p.lower()
    i = low.rfind(ROOT_MARK.lower())
    if i < 0:
        return None
    return p[i + len(ROOT_MARK):].lstrip("\\") or None


def read_line_count(text):
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def apply_diff_lines(text, diffs):
    """Apply a review's diffs by TEXT substitution, not by line number.

    `oldStart`/`newStart` are line numbers in the version the diff was taken
    from, which is not necessarily the version being replayed: files are edited
    by several agents over weeks. Splicing at those offsets makes the file drift
    (measured: a 1192-line reconstruction of a 578-line file, and a function body
    overwritten by an unrelated doc comment). Substituting `oldText` -> `newText`
    is what the edit tool actually did, so it is position-independent.

    Pure insertions (`oldText` empty) are the hard case: there is no text to
    anchor on. They are placed relative to the SURROUNDING hunks of the same
    review -- before a hunk that starts further down, after one that starts
    above -- and only fall back to a raw line offset when the review has no other
    hunk to orient by.
    """
    cur = text if text is not None else ""
    skipped = 0

    # Track where each hunk landed so pure insertions can be placed between them.
    landed = []          # (recorded_start, index_in_cur)
    placed = []          # (recorded_start, new_text) for content anchoring
    pending_inserts = []  # (recorded_start, new_text)

    for d in diffs:
        old_text = d.get("oldText")
        new_text = d.get("newText") or ""
        start = d.get("oldStart") or d.get("newStart") or 1
        if old_text is None:
            cur = new_text
            landed.append((start, 0))
            continue
        if not old_text:
            pending_inserts.append((start, new_text))
            continue
        n = cur.count(old_text)
        if n == 1:
            idx = cur.find(old_text)
            cur = cur.replace(old_text, new_text)
            landed.append((start, idx))
            placed.append((start, new_text))
        elif n > 1:
            want = max(0, start - 1)
            pos, best, idx = -1, None, 0
            while True:
                pos = cur.find(old_text, pos + 1)
                if pos < 0:
                    break
                dist = abs(cur.count("\n", 0, pos) - want)
                if best is None or dist < best:
                    best, idx = dist, pos
            cur = cur[:idx] + new_text + cur[idx + len(old_text):]
            landed.append((start, idx))
            placed.append((start, new_text))
        else:
            skipped += 1

    # Place pure insertions (oldText == "") by CONTENT.
    #
    # These are the hardest hunks: there is no old text to search for, and the
    # recorded line number belongs to a different version of the file. Placing by
    # that number produced the characteristic injury seen all over this recovery:
    # a whole `function` / `const` / CSS rule spliced INSIDE the block above it
    # (measured: `startJLinkBackend` nested in `start`, `persistNow` spliced into a
    # `disposers.push(` call, `readToolPaths` landing mid-comment in index.ts).
    #
    # Two content anchors are available and both are tried before falling back:
    #   * the hunk's own last line, after which the block is inserted;
    #   * a neighbouring hunk's first line, before which it is inserted.
    # When the block's first line is the tail of a doc comment (` * ...`), the
    # opening `/**` that the previous hunk consumed is put back in front, which is
    # what makes the comment whole again.
    for start, new_text in sorted(pending_inserts, key=lambda p: p[0], reverse=True):
        block = new_text if new_text.endswith("\n") else new_text + "\n"

        # Skip an insertion whose block is ALREADY in the file.
        #
        # A fork re-records a review that was already applied; replaying it again
        # inserts the same block twice, which is measurable as a reconstruction
        # larger than any version the tools ever read (measured: service.ts at 808
        # lines against a 540-line ceiling, config.ts at 581 against 321).
        if block.strip() and block.strip() in cur:
            skipped += 1
            continue

        first_line = block.split("\n", 1)[0]

        # A comment tail needs its opener back.
        needs_comment_open = first_line.lstrip().startswith("*") and not first_line.lstrip().startswith("/**")

        def try_insert(anchor_line, before):
            """Insert the block around an anchor line; return the new text or None."""
            if not anchor_line.strip():
                return None
            pos = cur.find(anchor_line + "\n")
            if pos < 0:
                return None
            at = pos if before else pos + len(anchor_line) + 1
            return cur[:at] + block + cur[at:]

        inserted = False
        # 1. after the last line of the previous hunk (same review, lower start)
        before_hunks = sorted([(s, t) for s, t in placed if s < start], key=lambda p: p[0], reverse=True)
        for _s, anchor_text in before_hunks:
            tail = anchor_text.rstrip("\n").split("\n")[-1]
            new_cur = try_insert(tail, before=False)
            if new_cur is not None:
                cur = new_cur
                inserted = True
                break
        if not inserted:
            # 2. before the first line of the next hunk
            after_hunks = sorted([(s, t) for s, t in placed if s > start], key=lambda p: p[0])
            for _s, anchor_text in after_hunks:
                head = anchor_text.split("\n", 1)[0]
                new_cur = try_insert(head, before=True)
                if new_cur is not None:
                    cur = new_cur
                    inserted = True
                    break
        if not inserted:
            # 3. last resort: the recorded offset, clamped into the file
            lines = cur.split("\n")
            at = min(max(start - 1, 0), len(lines))
            cur = "\n".join(lines[:at]) + "\n" + block + "\n".join(lines[at:])
            continue

        if needs_comment_open:
            marker = block.split("\n", 1)[0]
            pos = cur.find(marker + "\n")
            if pos > 0:
                prefix = cur[:pos].rstrip("\n")
                if not prefix.endswith("/**"):
                    cur = prefix + "\n/**\n" + cur[pos:]
    return cur, skipped


def load_events():
    """Ordered, de-duplicated, rejection-filtered events with review diffs attached."""
    # pass 1: rejections
    rejected = set()
    for f in sorted(HERE.glob("*.jsonl")):
        for line in f.open(encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("type") != "tool/result":
                continue
            d = ev.get("data") or {}
            msg = d.get("message") or {}
            src = (msg.get("source") or {}).get("callId")
            for part in msg.get("content") or []:
                cid = part.get("toolCallId") or src
                if not cid:
                    continue
                if part.get("type") == "tool-result":
                    if part.get("isError"):
                        rejected.add(cid)
                    for inner in part.get("content") or []:
                        txt = inner.get("text") or ""
                        if inner.get("type") == "text" and txt.lstrip().startswith("Error:"):
                            rejected.add(cid)
                elif part.get("type") == "text":
                    if part.get("isError") or (part.get("text") or "").lstrip().startswith("Error:"):
                        rejected.add(cid)

    events = []
    seen_calls = set()
    for f in sorted(HERE.glob("*.jsonl")):
        # diffs keyed by callId, collected per session
        diffs_by_cid = {}
        for line in f.open(encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get("type") == "tool/result":
                d = ev.get("data") or {}
                msg = d.get("message") or {}
                cid = (msg.get("source") or {}).get("callId")
                for part in msg.get("content") or []:
                    rev = part.get("dshFileReview")
                    if not rev:
                        continue
                    for fl in rev.get("files") or []:
                        rel = norm(fl.get("path"))
                        if rel is None:
                            continue
                        diffs_by_cid.setdefault(cid, []).append((rel, fl.get("diffs") or []))

        for line in f.open(encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            t = ev.get("type")
            d = ev.get("data") or {}
            base = (ev.get("time") or 0, ev.get("seq") or 0, f.stem)
            if t == "tool/call":
                name = d.get("name")
                if name not in ("write", "edit"):
                    continue
                cid = d.get("callId")
                if cid in seen_calls or cid in rejected:
                    continue
                seen_calls.add(cid)
                try:
                    args = json.loads(d.get("arguments") or "{}")
                except Exception:
                    continue
                events.append(base + ("call", (name, args, diffs_by_cid.get(cid))))
            elif t == "tool/result":
                for cid, rel, rows, total in read_snapshots(d):
                    if cid in rejected:
                        continue
                    events.append(base + ("read", (rel, rows, total, cid)))
    events.sort(key=lambda e: (e[0], e[1]))
    return events


def read_snapshots(data):
    message = (data or {}).get("message") or {}
    event_meta = (data or {}).get("meta") or {}
    for part in message.get("content") or []:
        if part.get("type") != "tool-result":
            continue
        meta = part.get("meta") or event_meta
        rel = norm(meta.get("path"))
        if rel is None:
            continue
        lines = meta.get("lines")
        if not isinstance(lines, list) or not lines:
            continue
        rows = [(l.get("number"), l.get("text", "")) for l in lines
                if isinstance(l, dict) and isinstance(l.get("number"), int)]
        if not rows:
            continue
        total = meta.get("total") or meta.get("totalLines")
        if not isinstance(total, int):
            total = rows[-1][0]
        yield part.get("toolCallId"), rel, rows, total


def main():
    events = load_events()
    state = {}
    st = dict(diff_frozen=0, diff=0, diff_fail=0, write=0, edit=0, edit_fail=0,
              snap_full=0, snap_splice=0, snap_stale=0, splice_refused=0)
    problems = []

    for time, seq, sid, kind, args in events:
        if kind == "read":
            rel, rows, total, _cid = args
            first, last = rows[0][0], rows[-1][0]
            if first == 1 and last >= total:
                body = "\n".join(t for _, t in rows) + "\n"
                cur = state.get(rel)
                # A fork re-reads an OLDER view of the file. A whole-file result
                # is authoritative when it matches what is already there or when
                # nothing better is known, but it must not overwrite a
                # reconstruction that has since grown beyond it -- that is the
                # fork's stale copy, and trusting it resets the file (measured:
                # a 460-line index.ts reset to its 421-line ancestor, and a
                # 578-line file rebuilt as 539).
                if cur is None or cur.rstrip("\n") == body.rstrip("\n"):
                    state[rel] = body
                    st["snap_full"] += 1
                else:
                    cur_n = cur.rstrip("\n").count("\n") + 1
                    body_n = body.rstrip("\n").count("\n") + 1
                    if body_n >= cur_n:
                        state[rel] = body
                        st["snap_full"] += 1
                    else:
                        st["snap_stale"] += 1
                        problems.append(("snap-stale", rel, sid, seq, body_n, cur_n))
            else:
                cur = state.get(rel)
                if cur is None:
                    continue
                cur_lines = cur.rstrip("\n").split("\n")
                # Padding with blank lines to reach a read's line numbers is
                # how a reconstruction silently inflates: when the read belongs
                # to a longer version of the file (another agent's copy, or one
                # our replay has not caught up with), the gap is NOT empty text,
                # it is content we do not have. Writing blanks there corrupts the
                # file, so an unbridgeable gap is refused and counted instead.
                if len(cur_lines) < last:
                    st["splice_refused"] += 1
                    problems.append(("splice-gap", rel, sid, seq, last, len(cur_lines)))
                    continue
                for num, text in rows:
                    if 1 <= num <= len(cur_lines):
                        cur_lines[num - 1] = text
                state[rel] = "\n".join(cur_lines) + "\n"
                st["snap_splice"] += 1
            continue

        name, cargs, reviews = args
        rel_target = norm(cargs.get("file_path"))
        if rel_target is None:
            continue

        # PREFER the edit call's own old_string/new_string when it actually
        # matches: that pair is exactly the operation the tool performed, and its
        # match proves the replay is at the right version of the file. The review
        # diff is only a fallback -- its hunks are line-addressed against whatever
        # version produced them, which is why replaying them as a block mangled
        # service.ts into 289 parse errors.
        if name == "write":
            if reviews:
                for rel, diffs in reviews:
                    if diffs:
                        before = state.get(rel)
                        after, frozen = apply_diff_lines(before, diffs)
                        state[rel] = after
                        st["diff"] += 1
                        st["diff_frozen"] += frozen
                continue
            state[rel_target] = cargs.get("content") or ""
            st["write"] += 1
            continue

        old = cargs.get("old_string") or ""
        new = cargs.get("new_string") or ""
        cur = state.get(rel_target)
        replace_all = bool(cargs.get("replace_all"))
        if cur is not None and old and (cur.count(old) == 1 or
                                        (replace_all and cur.count(old) > 0)):
            state[rel_target] = cur.replace(old, new) if replace_all else cur.replace(old, new, 1)
            st["edit"] += 1
            continue

        # Fall back to the recorded diff for this review.
        applied = False
        if reviews:
            for rel, diffs in reviews:
                if not diffs:
                    continue
                before = state.get(rel)
                after, frozen = apply_diff_lines(before, diffs)
                state[rel] = after
                st["diff"] += 1
                st["diff_frozen"] += frozen
                applied = True
        if applied:
            continue
        st["edit_fail"] += 1
        problems.append(("edit-fail", rel_target, sid, seq))

    for rel, content in sorted(state.items()):
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        with dst.open("w", encoding="utf-8", newline="") as fh:
            fh.write(content)

    print(f"rebuilt {len(state)} files -> {OUT}")
    for k, v in st.items():
        print(f"  {k:14s} {v}")
    if problems:
        print(f"\nproblems ({len(problems)}):")
        for p in problems[:20]:
            print("  ", p)


if __name__ == "__main__":
    main()
