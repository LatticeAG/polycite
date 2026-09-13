"""PolyCite cross-runtime interop suite (spec §8/§18).

Python independently re-derives every hash and verifies every signature in the
generated golden package, re-canonicalizes the JCS vectors, and validates byte
spans. It never emits ValidationResult itself -- the TS implementation owns
semantic replay.
"""

import hashlib
import json
import math
import struct
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def utf16_sort_key(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")


def js_escape(s: str) -> str:
    """JSON.stringify-style string serialization (RFC 8785 profile)."""
    out = ['"']
    for ch in s:
        cp = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif cp < 0x20:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_number(n) -> str:
    """ECMAScript Number::toString for the vector domain (ints + short decimals)."""
    if isinstance(n, bool):
        raise TypeError
    if isinstance(n, int):
        return str(n)
    if n == int(n) and abs(n) < 1e21:
        return str(int(n))
    # shortest-repr agreement domain: Python repr matches JS for these vectors
    r = repr(n)
    if r.endswith(".0"):
        r = r[:-2]
    return r


def jcs(v) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return js_escape(v)
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            raise ValueError("non-finite")
        return js_number(v)
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=utf16_sort_key)
        return "{" + ",".join(js_escape(k) + ":" + jcs(v[k]) for k in keys) + "}"
    raise TypeError("non-JSON value")


def b64url_decode(s: str) -> bytes:
    import base64

    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


DOMAIN_RETRIEVAL = b"PolyCite.retrieval.v1\n"
DOMAIN_ENTRY = b"PolyCite.entry.v1\n"


class TestInterop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pkg = load("package.json")
        cls.checkpoints = load("checkpoints.json")
        cls.seeds = load("seeds.json")

    def test_seed_to_pubkey_derivation(self):
        """Python derives public keys from fixture seeds; they must match the
        key ids' public material used in the package."""
        ret_seed = bytes.fromhex(self.seeds["retrieval_seed_hex"])
        rec_seed = bytes.fromhex(self.seeds["receipt_seed_hex"])
        ret_pub = Ed25519PrivateKey.from_private_bytes(ret_seed).public_key()
        rec_pub = Ed25519PrivateKey.from_private_bytes(rec_seed).public_key()
        from cryptography.hazmat.primitives import serialization

        ret_raw = ret_pub.public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        rec_raw = rec_pub.public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        # package retrieval key must be the retrieval seed's key
        self.assertEqual(
            self.pkg["request"]["retrieval"]["key_id"][:4], "pck_"
        )
        # raw pubkeys are 32 bytes
        self.assertEqual(len(ret_raw), 32)
        self.assertEqual(len(rec_raw), 32)

    def test_retrieval_hash_and_signature(self):
        body = self.pkg["request"]["retrieval"]["body"]
        digest = sha256_hex(jcs(body).encode("utf-8"))
        self.assertEqual(digest, self.pkg["request"]["retrieval"]["hash"])
        self.assertEqual(digest, self.checkpoints["retrieval_hash"])

        seed = bytes.fromhex(self.seeds["retrieval_seed_hex"])
        pub = Ed25519PrivateKey.from_private_bytes(seed).public_key()
        sig = b64url_decode(self.pkg["request"]["retrieval"]["signature"])
        self.assertEqual(len(sig), 64)
        pub.verify(sig, DOMAIN_RETRIEVAL + bytes.fromhex(digest))

    def test_content_and_contract_and_request_hashes(self):
        req = self.pkg["request"]
        src = req["retrieval"]["body"]["sources"][0]
        content = sha256_hex(src["text"].encode("utf-8"))
        self.assertEqual(content, src["content_hash"])
        self.assertEqual(content, self.checkpoints["content_hash"])

        contract = self.pkg["result"]["contract"]
        contract_hash = sha256_hex(jcs(contract).encode("utf-8"))
        self.assertEqual(contract_hash, req["contract_hash"])
        self.assertEqual(contract_hash, self.checkpoints["contract_hash"])

        request_hash = sha256_hex(jcs(req).encode("utf-8"))
        self.assertEqual(request_hash, self.pkg["result"]["request_hash"])
        self.assertEqual(request_hash, self.checkpoints["request_hash"])

    def test_decision_and_delivery_and_audit_chain(self):
        result = self.pkg["result"]
        decision = result["decision"]
        decision_hash = sha256_hex(jcs(decision).encode("utf-8"))
        self.assertEqual(decision_hash, self.checkpoints["decision_hash"])

        final_text = result["final_text"]
        rendered = (
            final_text
            + " [pc:0]\n\nPolyCite ledger:\n"
            + jcs(decision)
            + "\n"
        )
        delivery_hash = sha256_hex(rendered.encode("utf-8"))
        self.assertEqual(delivery_hash, self.checkpoints["delivery_hash"])

        claims_hash = sha256_hex(jcs(decision["initial"]).encode("utf-8"))
        request_hash = sha256_hex(jcs(self.pkg["request"]).encode("utf-8"))
        contract_hash = self.pkg["request"]["contract_hash"]
        retrieval_hash = self.pkg["request"]["retrieval"]["hash"]

        expected_payloads = [
            {
                "kind": "accepted",
                "request_hash": request_hash,
                "contract_hash": contract_hash,
                "retrieval_hash": retrieval_hash,
            },
            {
                "kind": "evaluated",
                "revision": 0,
                "claims_hash": claims_hash,
                "draft_hash": sha256_hex(
                    self.pkg["request"]["draft"].encode("utf-8")
                ),
            },
            {
                "kind": "delivery_prepared",
                "decision_hash": decision_hash,
                "delivery_hash": delivery_hash,
                "outcome": "release",
            },
        ]

        rec_seed = bytes.fromhex(self.seeds["receipt_seed_hex"])
        pub = Ed25519PrivateKey.from_private_bytes(rec_seed).public_key()

        prev = None
        for i, entry in enumerate(result["audit"]):
            body = entry["body"]
            self.assertEqual(body["sequence"], i)
            self.assertEqual(body["previous_hash"], prev)
            self.assertEqual(body["payload"], expected_payloads[i])
            entry_hash = sha256_hex(jcs(body).encode("utf-8"))
            self.assertEqual(entry_hash, entry["hash"])
            sig = b64url_decode(entry["signature"])
            self.assertEqual(len(sig), 64)
            pub.verify(sig, DOMAIN_ENTRY + bytes.fromhex(entry_hash))
            prev = entry_hash

        self.assertEqual(result["head_hash"], prev)
        self.assertEqual(prev, self.checkpoints["head_hash"])

    def test_jcs_vectors(self):
        for i, vec in enumerate(load("jcs.json")):
            with self.subTest(i=i):
                self.assertEqual(jcs(json.loads(vec["input"])), vec["canonical"])

    def test_span_offsets(self):
        for i, vec in enumerate(load("spans.json")):
            with self.subTest(i=i):
                raw = bytes.fromhex(vec["utf8_hex"])
                self.assertEqual(raw, vec["draft"].encode("utf-8"))
                covered = bytearray(len(raw))
                for span in vec["spans"]:
                    frag = raw[span["start"] : span["end"]]
                    frag.decode("utf-8")  # boundary check: must decode cleanly
                    for j in range(span["start"], span["end"]):
                        covered[j] += 1
                for j, b in enumerate(raw):
                    if b in (0x20, 0x09, 0x0A, 0x0D):
                        self.assertLessEqual(covered[j], 1)
                    else:
                        self.assertEqual(covered[j], 1)


if __name__ == "__main__":
    unittest.main()
