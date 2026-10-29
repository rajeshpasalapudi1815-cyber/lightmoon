"""Writes lightmoon_train.ipynb from the cells below, with eval.py inside it, so the notebook needs nothing
else from this folder. Run it after changing either: python make_notebook.py"""
import json
from pathlib import Path

HERE = Path(__file__).parent

INTRO = """# Teach LightMoon's own model

This teaches a small AI (Qwen3 1.7B) to answer the way LightMoon's big AI does, from the training file LightMoon
made (Settings → AI brain → *Download training data*). At the end you get one file,
`lightmoon-YYYY-MM-DD.Q4_K_M.gguf` (about 1.1 GB), that runs on your computer, and later on your phone.

**On Kaggle**
1. On the right, under *Session options*: Accelerator **GPU T4 x2**, and Internet **On** (Kaggle asks you to
   verify your phone number once before it allows internet).
2. *+ Add Input* → *Upload* → choose your `lightmoon-training-….jsonl` file (or several: one from each device).
   Give the dataset any name.
3. Press **Run All**. It takes from about half an hour to a few hours, depending on how much you've collected.
4. When the last cell says **Done**, open *Output* on the right and download the `.gguf` file.

**On Google Colab** (if Kaggle isn't available): *Runtime* → *Change runtime type* → **T4 GPU**, then
*Runtime* → *Run all*. It asks for the training file, and downloads the `.gguf` file at the end.

Nothing here changes LightMoon itself: the file only becomes its model once you put it in place on your computer
(see `trainer/README.md`)."""

SETTINGS = '''# Settings. The defaults are fine; change them only if you know why.
BASE_MODEL = "unsloth/Qwen3-1.7B"  # or "unsloth/Qwen2.5-1.5B-Instruct": a little smaller, not as good with tools
MAX_LEN = 8192        # the longest conversation it learns from, in tokens (LightMoon's instructions are long)
MAX_TRAIN = 3000      # at most this many answers to learn from (the most recent)
EVAL_CASES = 120      # answers held back from training, to score it before and after
LEARNING_RATE = 2e-4'''

INSTALL = '''# The training tools (a few minutes).
!pip install -q unsloth 2>&1 | tail -n 3'''

FIND_DATA = '''# Your training file(s): every .jsonl added as input (Kaggle), or uploaded now (Colab).
import glob, json, os, random, shutil, subprocess, sys, time
from datetime import date
import eval as ev

IN_COLAB = "google.colab" in sys.modules
WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else "/content"
files = sorted(glob.glob("/kaggle/input/**/*.jsonl", recursive=True) + glob.glob("/content/*.jsonl"))
if not files and IN_COLAB:
    from google.colab import files as colab_files
    print("Choose your LightMoon training file(s):")
    files = [os.path.abspath(name) for name in colab_files.upload()]
if not files:
    raise SystemExit("No training file found. Add it with '+ Add Input' -> 'Upload', then press Run All again.")

examples = ev.load_examples(files)
train_examples = [e for e in examples if not ev.is_held_out(e)]
held_out = [e for e in examples if ev.is_held_out(e)]
train_cases = [case for e in train_examples for case in ev.cases(e)][-MAX_TRAIN:]
eval_cases = [case for e in held_out for case in ev.cases(e)][:EVAL_CASES]
print(f"{len(examples)} conversations from {len(files)} file(s): {len(train_cases)} answers to learn from, "
      f"{len(eval_cases)} held back to test it.")
if len(train_cases) < 30:
    raise SystemExit("That's too few to learn from yet. Let LightMoon collect for a while longer (a few hundred is good).")
if len(eval_cases) < 20:
    print("Few answers are held back for testing, so the scores below will be rough.")'''

LOAD_MODEL = '''# The model to teach.
from unsloth import FastLanguageModel
import torch

model, tokenizer = FastLanguageModel.from_pretrained(BASE_MODEL, max_seq_length=MAX_LEN, load_in_4bit=False, dtype=None)
model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=16, lora_dropout=0, bias="none", random_state=3407,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
)'''

PREPARE = '''# Each answer the big model gave becomes one lesson: everything before it is context, the answer is what it learns.
ASSISTANT_MARK = "<|im_start|>assistant\\n"

def for_template(messages):
    """Tool-call arguments as objects (what chat templates expect), and no missing text."""
    out = []
    for m in messages:
        m = {**m, "content": m.get("content") or ""}
        if m.get("tool_calls"):
            m["tool_calls"] = [{**c, "function": {**c["function"], "arguments": ev.parse_args(c["function"].get("arguments"))}}
                               for c in m["tool_calls"]]
        out.append(m)
    return out

def render(messages, tools, generation_prompt):
    # enable_thinking=False: answer straight away, as LightMoon asks llama-server to.
    return tokenizer.apply_chat_template(for_template(messages), tools=tools or None, tokenize=False,
                                         add_generation_prompt=generation_prompt, enable_thinking=False)

def lesson(prefix, expected, tools):
    prompt = render(prefix, tools, True)
    full = render(prefix + [expected], tools, False)
    split = len(prompt) if full.startswith(prompt) else full.rfind(ASSISTANT_MARK) + len(ASSISTANT_MARK)
    context = tokenizer(full[:split], add_special_tokens=False)["input_ids"]
    answer = tokenizer(full[split:], add_special_tokens=False)["input_ids"]
    if len(context) + len(answer) > MAX_LEN:
        return None
    return {"input_ids": context + answer, "attention_mask": [1] * (len(context) + len(answer)),
            "labels": [-100] * len(context) + answer}

lessons = [x for x in (lesson(*case) for case in train_cases) if x]
random.Random(3407).shuffle(lessons)
EPOCHS = 2 if len(lessons) < 1000 else 1
print(f"{len(lessons)} lessons ({len(train_cases) - len(lessons)} too long, skipped), {EPOCHS} pass(es) through them.")'''

SCORE = '''# How often it does what the big model did, on answers it never learned from (the same rule as LightMoon's).
def score(title):
    if not eval_cases:
        print("Nothing held back to test with yet.")
        return None
    FastLanguageModel.for_inference(model)
    tally = ev.Tally()
    for n, (prefix, expected, tools) in enumerate(eval_cases, 1):
        ids = tokenizer(render(prefix, tools, True), add_special_tokens=False, return_tensors="pt")["input_ids"]
        if ids.shape[1] > MAX_LEN - 256:
            continue
        with torch.no_grad():
            out = model.generate(input_ids=ids.to(model.device), attention_mask=torch.ones_like(ids).to(model.device),
                                 max_new_tokens=256, do_sample=False, pad_token_id=tokenizer.eos_token_id)
        text = tokenizer.decode(out[0, ids.shape[1]:], skip_special_tokens=False)
        tally.add(ev.compare(expected, ev.parse_generated(text), tools, prefix))
        print(f"\\r{n} of {len(eval_cases)}", end="")
    print("\\r" + tally.report(title))
    return tally

before = score("Before training")'''

TRAIN = '''# The teaching itself: the longest step.
from datasets import Dataset
from transformers import DataCollatorForSeq2Seq, Trainer, TrainingArguments
from unsloth import is_bfloat16_supported

FastLanguageModel.for_training(model)
trainer = Trainer(
    model=model,
    train_dataset=Dataset.from_list(lessons),
    data_collator=DataCollatorForSeq2Seq(tokenizer, padding=True, label_pad_token_id=-100),
    args=TrainingArguments(
        output_dir="/tmp/outputs", per_device_train_batch_size=1, gradient_accumulation_steps=8,
        num_train_epochs=EPOCHS, learning_rate=LEARNING_RATE, warmup_ratio=0.05, lr_scheduler_type="cosine",
        weight_decay=0.01, optim="adamw_8bit", fp16=not is_bfloat16_supported(), bf16=is_bfloat16_supported(),
        logging_steps=10, save_strategy="no", report_to="none", seed=3407,
    ),
)
started = time.time()
trainer.train()
print(f"Taught in {(time.time() - started) / 60:.0f} minutes.")'''

AFTER = '''after = score("After training")'''

EXPORT = '''# One file for llama.cpp (GGUF, Q4_K_M: about 1.1 GB), named for today so LightMoon can tell when it was taught.
name = f"lightmoon-{date.today().isoformat()}"
final = f"{WORK}/{name}.Q4_K_M.gguf"

def sh(command):
    subprocess.run(command, shell=True, check=True)

def new_gguf_files(since):
    found = glob.glob(f"{WORK}/**/*.gguf", recursive=True) + glob.glob("/tmp/**/*.gguf", recursive=True)
    return [f for f in found if os.path.getmtime(f) >= since and "q4_k_m" in os.path.basename(f).lower() and f != final]

started = time.time()
try:
    model.save_pretrained_gguf(f"/tmp/{name}", tokenizer, quantization_method="q4_k_m")
    os.replace(max(new_gguf_files(started), key=os.path.getmtime), final)
except Exception as err:  # Unsloth's own export changes from version to version: llama.cpp's tools, directly
    print(f"Unsloth's export didn't work ({err}); using llama.cpp's own tools instead.")
    model.save_pretrained_merged("/tmp/merged", tokenizer, save_method="merged_16bit")
    if not os.path.isdir("/tmp/llama.cpp"):
        sh("git clone -q --depth 1 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp")
    sh("pip install -q /tmp/llama.cpp/gguf-py sentencepiece protobuf mistral_common")
    sh("python /tmp/llama.cpp/convert_hf_to_gguf.py /tmp/merged --outtype f16 --outfile /tmp/f16.gguf")
    sh("cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF > /dev/null"
       " && cmake --build /tmp/llama.cpp/build --target llama-quantize -j 4 > /dev/null")
    sh(f"/tmp/llama.cpp/build/bin/llama-quantize /tmp/f16.gguf {final} Q4_K_M")

# Only the model and its report stay in Output.
for leftover in [f"{WORK}/{name}", f"{WORK}/{name}_gguf", f"{WORK}/llama.cpp", f"{WORK}/outputs", f"{WORK}/__pycache__"]:
    shutil.rmtree(leftover, ignore_errors=True)
for leftover in [f"{WORK}/eval.py", *new_gguf_files(started)]:
    if os.path.exists(leftover):
        os.remove(leftover)

with open(f"{WORK}/{name}-report.txt", "w") as report:
    report.write(f"{name}: taught from {len(lessons)} answers in {len(examples)} conversations, {EPOCHS} pass(es), base {BASE_MODEL}.\\n\\n")
    for tally in (before, after):
        if tally:
            report.write(tally.report("Before training" if tally is before else "After training") + "\\n\\n")
print(f"Done: {os.path.basename(final)} ({os.path.getsize(final) / 1e9:.2f} GB).")
if IN_COLAB:
    colab_files.download(final)
else:
    print("Download it from Output on the right (the /kaggle/working folder).")'''

FINISH = """## Then, on your computer

Leave the downloaded `.gguf` file in Downloads and double-click **Start our model** in
`C:\\Users\\<you>\\LightMoon\\own-model`: it moves the file into `models` and starts using it. LightMoon's
*Our model on this computer* card then shows the new model and when it was taught, and scores it afresh. Keep
collecting: teaching it again later, with more examples, makes it better."""


def markdown(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.splitlines(keepends=True)}


def code(text):
    return {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": text.splitlines(keepends=True)}


def main():
    eval_source = (HERE / "eval.py").read_text(encoding="utf-8")
    cells = [
        markdown(INTRO),
        code(SETTINGS),
        code(INSTALL),
        code("%%writefile eval.py\n" + eval_source),
        code(FIND_DATA),
        code(LOAD_MODEL),
        code(PREPARE),
        code(SCORE),
        code(TRAIN),
        code(AFTER),
        code(EXPORT),
        markdown(FINISH),
    ]
    notebook = {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
            "accelerator": "GPU",
            "colab": {"provenance": [], "gpuType": "T4"},
            "kaggle": {"accelerator": "nvidiaTeslaT4", "isInternetEnabled": True, "isGpuEnabled": True, "language": "python", "sourceType": "notebook"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    (HERE / "lightmoon_train.ipynb").write_text(json.dumps(notebook, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote lightmoon_train.ipynb")


if __name__ == "__main__":
    main()
