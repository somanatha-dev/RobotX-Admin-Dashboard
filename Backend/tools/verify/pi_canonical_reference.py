#!/usr/bin/env python3
"""
P2B-2 — a Python reference for the RobotX command-signature canonical form, checked
against the backend-generated test vector (docs/contracts/fixtures/offer-signature-test-vector.json).

It implements the three assumptions the Pi reported, and nothing else:
  1. `notValidAfter` renders WITHOUT quotes (and so do fence / authorityEpoch / fenceFloor,
     which render as integer digits);
  2. object keys are sorted at EVERY depth (arrays keep their order);
  3. the key is the UTF-8 bytes of COMMAND_SIGNING_KEY.

plus the one thing Python gets wrong by default: every other scalar must be rendered the
way ECMAScript's JSON.stringify renders it. The script also shows, for the same vector,
what naive `json.dumps` defaults would produce, so the byte-level traps are named.

Usage:  python pi_canonical_reference.py <vector.json>
Exit 0 when the reference reproduces the backend signature and the naive rendering is shown
to differ (proving the vector exercises the traps).
"""

import decimal
import hashlib
import hmac
import json
import sys
from datetime import datetime, timezone

SEPARATOR = "\u001f"
SIGNED_FIELDS = [
    "agentId", "command", "commandClass", "fenceScope", "commitmentId", "fence",
    "authorityEpoch", "fenceFloor", "sequence", "notValidAfter", "payload",
]
INTEGER_FIELDS = {"fence", "authorityEpoch", "fenceFloor"}


def js_number(x):
    """ECMAScript Number::toString for a finite double (what JSON.stringify emits)."""
    if isinstance(x, bool):
        raise TypeError("bool is not a number here")
    if isinstance(x, int):
        x = float(x) if abs(x) >= 2 ** 53 else x
        if isinstance(x, int):
            return str(x)
    if x != x or x in (float("inf"), float("-inf")):
        return "null"  # JSON.stringify(NaN/Infinity) === "null"
    if x == 0:
        return "0"  # also -0
    sign = "-" if x < 0 else ""
    d = decimal.Decimal(repr(abs(x)))  # repr is the shortest round-trip, as in JS
    digits = str(d.as_tuple().digits and int("".join(map(str, d.as_tuple().digits))))
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    # value = 0.digits × 10^n
    n = d.adjusted() + 1
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    exp = n - 1
    exp_text = ("+" if exp >= 0 else "-") + str(abs(exp))
    if k == 1:
        return sign + digits + "e" + exp_text
    return sign + digits[0] + "." + digits[1:] + "e" + exp_text


def js_string(s):
    # JSON.stringify: non-ASCII emitted raw (ensure_ascii=False); control chars escaped.
    return json.dumps(s, ensure_ascii=False)


def js_key_order(keys):
    # JS sorts by UTF-16 code units; Python by code points. They differ only for astral
    # characters, so sort on the UTF-16 encoding to be exact.
    return sorted(keys, key=lambda k: k.encode("utf-16-be"))


def render(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return js_string(value)
    if isinstance(value, list):
        return "[" + ",".join(render(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(js_string(k) + ":" + render(value[k]) for k in js_key_order(value.keys())) + "}"
    raise TypeError(type(value))


def render_field(field, value):
    if value is None:
        return "null"
    if field in INTEGER_FIELDS:
        return str(int(str(value)))
    if field == "notValidAfter":
        at = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
        return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"
    return render(value)


def canonical(envelope):
    return SEPARATOR.join(f"{f}={render_field(f, envelope.get(f))}" for f in SIGNED_FIELDS)


def naive(envelope):
    """The same, but with Python's json defaults for scalars — the traps."""
    def r(v):
        if isinstance(v, dict):
            return "{" + ",".join(json.dumps(k) + ":" + r(v[k]) for k in sorted(v)) + "}"
        if isinstance(v, list):
            return "[" + ",".join(r(x) for x in v) + "]"
        return json.dumps(v)
    parts = []
    for f in SIGNED_FIELDS:
        v = envelope.get(f)
        parts.append(f"{f}={render_field(f, v) if f in INTEGER_FIELDS or f == 'notValidAfter' else r(v)}")
    return SEPARATOR.join(parts)


def sign(text, key):
    return hmac.new(key.encode("utf-8"), text.encode("utf-8"), hashlib.sha256).hexdigest()


def main(path):
    vector = json.load(open(path, encoding="utf-8"))
    # A Python client that parses floats as floats — what the Pi's socket library does.
    envelope = json.loads(vector["wire"])
    ours = canonical(envelope)
    signature = sign(ours, vector["key"])
    ok = signature == vector["signature"] and ours == vector["canonical"]
    print(f"reference canonical == backend canonical : {ours == vector['canonical']}")
    print(f"reference signature == backend signature : {signature == vector['signature']}")

    trap = naive(envelope)
    first = next((i for i, (a, b) in enumerate(zip(trap, vector["canonical"])) if a != b), None)
    print(f"naive json.dumps rendering differs       : {trap != vector['canonical']}"
          + (f" (first difference at byte {first}: {trap[max(0, first - 30):first + 30]!r})" if first is not None else ""))
    if not ok:
        print("FAIL")
        return 1
    print("PASS")
    return 0 if trap != vector["canonical"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
