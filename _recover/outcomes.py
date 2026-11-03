"""Collect tool-call outcomes across BOTH session formats (v3 and v4).

v3: message.content[].type == "tool-result", isError on that part
v4: message.content[].type == "text" -- the failure shows up in the text itself
    ("Error: ...") and/or isError on the part.

Mixing them up silently mislabels hundreds of edit calls, so both are handled.
"""
import json
from collections import Counter
from pathlib import Path
import rebuild

HERE = rebuild.HERE


def iter_result_parts(data):
    message = (data or {}).get("message") or {}
    for part in message.get("content") or []:
        yield part


def call_outcomes():
    """callId -> (name, seq, session, is_error, text)"""
    out = {}
    for f in sorted(HERE.glob("*.jsonl")):
        calls = {}
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
            if t == "tool/call":
                calls[d.get("callId")] = (d.get("name"), ev.get("seq"), f.stem)
        # second pass for results
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
            for part in iter_result_parts(d):
                cid = part.get("toolCallId")
                if cid not in calls:
                    # v4 keeps the id on the message source
                    cid = ((d.get("message") or {}).get("source") or {}).get("callId")
                if cid not in calls:
                    continue
                if part.get("type") == "tool-result":
                    texts = [i.get("text", "") for i in part.get("content") or []
                             if i.get("type") == "text"]
                    text = "\n".join(texts)
                    is_err = bool(part.get("isError"))
                elif part.get("type") == "text":
                    text = part.get("text") or ""
                    is_err = bool(part.get("isError")) or text.lstrip().startswith("Error:")
                else:
                    continue
                name, seq, sess = calls[cid]
                prev = out.get(cid)
                if prev is None or (is_err and not prev[3]):
                    out[cid] = (name, seq, sess, is_err, text)
    return out


if __name__ == "__main__":
    out = call_outcomes()
    c = Counter()
    errs = []
    for cid, (name, seq, sess, is_err, text) in out.items():
        if name not in ("write", "edit"):
            continue
        c[f"{name}:{'error' if is_err else 'ok'}"] += 1
        if is_err:
            errs.append((sess, seq, name, text[:100]))
    print("outcomes:", dict(c))
    print(f"\nrejected: {len(errs)}")
    for e in errs[:25]:
        print("  ", e)
