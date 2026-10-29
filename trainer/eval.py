"""How often our model does what the big model did, on examples it never trained on.

The rule is the same as LightMoon's own comparison (docs/js/learning.js):
- The big model called tools: our model must call the same tools, and the arguments that matter must agree
  (the required ones and any time; ids, numbers and choices exactly, times to the minute, text with mostly the
  same words).
- The big model answered in words: our model must answer in words too, sharing at least 40% of its words.
Each case counts under every kind either model chose (a tool's name, "talk", "after-tool", "briefing"), so a
kind's score also drops when our model does that kind when it shouldn't.

The training notebook uses this file to hold back one example in ten and to score the model before and after
training. On a computer, it can score our model while llama-server runs it (standard library only):

    python eval.py lightmoon-training-2026-11-02.jsonl --server http://127.0.0.1:8080/v1
"""
import argparse
import hashlib
import json
import re
import sys
import urllib.request
from datetime import datetime

SIMILAR_REPLY = 0.4
SIMILAR_TEXT = 0.5
MAX_STEPS = 4
HELD_OUT_EVERY = 10  # one example in ten is never trained on
BRIEFING_REQUEST = re.compile(r"^\(Automatic message: I just opened the app")
TIME_KEY = re.compile(r"(_at|_date|^start|^date)$")
KIND_NAMES = {"talk": "Just talking", "after-tool": "Confirming what it did", "briefing": "Spoken briefings", "writing": "Other writing"}


# ---------- The examples ----------

def load_examples(paths):
    """Every example in the files, once (the same conversation exported twice counts once)."""
    seen, examples = set(), []
    for path in paths:
        with open(path, encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                example = json.loads(line)
                key = example_id(example)
                if key not in seen:
                    seen.add(key)
                    examples.append(example)
    return examples


def example_id(example):
    return hashlib.sha256(json.dumps(example["messages"], sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def is_held_out(example):
    return int(example_id(example)[:8], 16) % HELD_OUT_EVERY == 0


def cases(example):
    """Each answer the big model gave after the last thing the user said, with everything before it."""
    messages, tools = example["messages"], example.get("tools")
    last_user = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
    steps = [i for i, m in enumerate(messages) if i > last_user and m["role"] == "assistant"][:MAX_STEPS]
    return [(messages[:i], messages[i], tools) for i in steps]


# ---------- Comparing two answers ----------

def words(text):
    return set(re.findall(r"(?:[^\W_]|')+", str(text or "").lower()))


def similarity(a, b):
    """Shared words over all words (Dice), from 0 to 1."""
    x, y = words(a), words(b)
    if not x and not y:
        return 1.0
    return 2 * len(x & y) / (len(x) + len(y))


def tool_names(message):
    return sorted((call.get("function") or {}).get("name") or "" for call in message.get("tool_calls") or [])


def kinds_of(message, tools, prefix):
    names = tool_names(message)
    if names:
        return sorted({f"tool:{name}" for name in names})
    if not tools:
        last_user = next((m.get("content") or "" for m in reversed(prefix) if m["role"] == "user"), "")
        return ["briefing" if BRIEFING_REQUEST.match(last_user) else "writing"]
    return ["after-tool" if prefix and prefix[-1]["role"] == "tool" else "talk"]


def parse_args(value):
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def normalize_time(value):
    text = str(value).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    try:
        moment = datetime.fromisoformat(text.replace(" ", "T").replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment.strftime("%Y-%m-%dT%H:%M")


def bare_id(value):
    return re.sub(r"\]$", "", re.sub(r"^\[?#", "", str(value)))


def arguments_agree(name, expected_args, answer_args, tools):
    schema = next(((t.get("function") or {}).get("parameters") or {} for t in tools or [] if (t.get("function") or {}).get("name") == name), {})
    properties = schema.get("properties") or {}
    keys = set(schema.get("required") or []) | {key for key in properties if TIME_KEY.search(key)}
    expected, answer = parse_args(expected_args), parse_args(answer_args)
    for key in keys:
        a, b = expected.get(key), answer.get(key)
        if a is None or a == "":
            if not (b is None or b == ""):
                return False
            continue
        if b is None:
            return False
        spec = properties.get(key) or {}
        if TIME_KEY.search(key):
            same = normalize_time(a) == normalize_time(b)
        elif key == "id" or key.endswith("_id") or key == "reply_to":
            same = bare_id(a) == bare_id(b)
        elif spec.get("type") == "string" and not spec.get("enum"):
            same = similarity(a, b) >= SIMILAR_TEXT
        else:
            same = str(a).lower() == str(b).lower()
        if not same:
            return False
    return True


def compare(expected, answer, tools, prefix):
    """One case: {"kinds": [...], "agree": bool, "similar": float or None}."""
    kinds = sorted(set(kinds_of(expected, tools, prefix)) | set(kinds_of(answer, tools, prefix)))
    want, got = tool_names(expected), tool_names(answer)
    similar = None
    if want or got:
        agree = want == got
        for name in want if agree else []:
            a = next(c for c in expected["tool_calls"] if c["function"]["name"] == name)
            b = next(c for c in answer["tool_calls"] if c["function"]["name"] == name)
            agree = agree and arguments_agree(name, a["function"].get("arguments"), b["function"].get("arguments"), tools)
    else:
        similar = similarity(expected.get("content"), answer.get("content"))
        agree = similar >= SIMILAR_REPLY
    return {"kinds": kinds, "agree": agree, "similar": similar}


# ---------- Getting our model's answer ----------

def parse_generated(text):
    """A raw reply in Qwen's format (text, and tool calls as <tool_call>{"name", "arguments"}</tool_call>)."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    text = text.split("<|im_end|>")[0]
    calls = []
    for i, raw in enumerate(re.findall(r"<tool_call>\s*(.*?)\s*</tool_call>", text, flags=re.S)):
        try:
            call = json.loads(raw)
        except ValueError:
            continue
        arguments = call.get("arguments", call.get("parameters", {}))
        calls.append({"id": f"gen_{i}", "type": "function", "function": {
            "name": call.get("name", ""), "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)}})
    content = re.sub(r"<tool_call>.*?</tool_call>", "", text, flags=re.S).strip()
    return {"role": "assistant", "content": content, **({"tool_calls": calls} if calls else {})}


def ask_server(server, prefix, tools, timeout=300):
    """Our model's answer from an OpenAI-compatible server such as llama-server."""
    body = {"model": "local", "messages": prefix, "temperature": 0.2, "max_tokens": 400, "stream": False,
            "chat_template_kwargs": {"enable_thinking": False}}
    if tools:
        body.update(tools=tools, tool_choice="auto")
    request = urllib.request.Request(f"{server.rstrip('/')}/chat/completions", data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        message = json.load(response)["choices"][0]["message"]
    content = re.sub(r"<think>.*?</think>\s*", "", message.get("content") or "", flags=re.S).strip()
    calls = [{"id": c.get("id") or f"local_{i}", "type": "function", "function": {
        "name": c["function"]["name"],
        "arguments": c["function"]["arguments"] if isinstance(c["function"]["arguments"], str) else json.dumps(c["function"]["arguments"])}}
        for i, c in enumerate(message.get("tool_calls") or [])]
    return {"role": "assistant", "content": content, **({"tool_calls": calls} if calls else {})}


# ---------- Adding it up ----------

class Tally:
    def __init__(self):
        self.kinds = {}
        self.cases = 0
        self.agreed = 0

    def add(self, result):
        self.cases += 1
        self.agreed += result["agree"]
        for kind in result["kinds"]:
            tally = self.kinds.setdefault(kind, {"cases": 0, "agreed": 0, "similar": 0.0, "talks": 0})
            tally["cases"] += 1
            tally["agreed"] += result["agree"]
            if result["similar"] is not None:
                tally["similar"] += result["similar"]
                tally["talks"] += 1

    def overall(self):
        return self.agreed / self.cases if self.cases else 0.0

    def report(self, title="Our model"):
        lines = [f"{title}: agreed with the big model in {self.agreed} of {self.cases} cases ({100 * self.overall():.0f}%)"]
        for kind, tally in sorted(self.kinds.items(), key=lambda item: -item[1]["cases"]):
            name = KIND_NAMES.get(kind, kind.removeprefix("tool:").replace("_", " ").capitalize())
            alike = f", replies {100 * tally['similar'] / tally['talks']:.0f}% alike" if tally["talks"] else ""
            lines.append(f"  {name:<28} {tally['agreed']:>4} of {tally['cases']:<4} {100 * tally['agreed'] / tally['cases']:>4.0f}%{alike}")
        return "\n".join(lines)

    def as_dict(self):
        return {"cases": self.cases, "agreed": self.agreed, "kinds": self.kinds}


def main():
    parser = argparse.ArgumentParser(description="Score our model against the big model's answers.")
    parser.add_argument("files", nargs="+", help="training data from LightMoon (.jsonl)")
    parser.add_argument("--server", default="http://127.0.0.1:8080/v1", help="our model's address (llama-server)")
    parser.add_argument("--all", action="store_true", help="every example, not only the ones held back from training")
    parser.add_argument("--limit", type=int, default=200, help="at most this many cases")
    parser.add_argument("--report", default="eval-report.json")
    options = parser.parse_args()

    examples = [e for e in load_examples(options.files) if options.all or is_held_out(e)]
    todo = [case for example in examples for case in cases(example)][: options.limit]
    if not todo:
        sys.exit("No held-back examples to score yet (one in ten is held back). Try --all.")
    tally = Tally()
    for n, (prefix, expected, tools) in enumerate(todo, 1):
        try:
            answer = ask_server(options.server, prefix, tools)
        except OSError as err:
            sys.exit(f"Can't reach our model at {options.server}: {err}")
        tally.add(compare(expected, answer, tools, prefix))
        print(f"\r{n} of {len(todo)} cases", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    print(tally.report())
    with open(options.report, "w", encoding="utf-8") as file:
        json.dump(tally.as_dict(), file, indent=2)


if __name__ == "__main__":
    main()
