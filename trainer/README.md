# LightMoon's own model

LightMoon thinks with a big AI on the internet (gpt-oss-120b, through Groq). This folder gives it a small AI of
its own that learns from the big one's answers, while the big one keeps doing the work. Later, the same small
model becomes the phone's offline brain.

## How the loop works

1. **It collects.** With *Teach our own model* on, every time the big AI finishes answering you, LightMoon keeps
   a copy of that exchange on the device: what it was asked, which of its tools it used (adding a reminder,
   remembering something...) and what it said. That copy is one lesson.
2. **It learns.** Every few weeks you download the lessons as one file and give it to a free notebook on Kaggle,
   which teaches a small model (Qwen3 1.7B) to answer the same way. You get back one file of about 1.1 GB.
3. **It practises.** That file runs on your computer. After each answer from the big AI, LightMoon quietly asks
   our model the same thing and checks whether it would have done the same: the same tool with the same details,
   or a reply that says much the same. You never see or hear its answers. Settings shows how often it agrees,
   for each kind of request.
4. **It takes over, bit by bit.** If you switch on *Let our model handle a kind once it's reliable*, a kind of
   request it has got right at least 95 times in 100, over at least 50 tries, and answers within about 15
   seconds, is answered by our model instead. If it has any trouble, the big AI answers as before.
5. Repeat 2 to 4 now and then: more lessons make it better, and each new model is scored afresh.

## What you do

**Once, on each device you use:** Settings → *AI brain* → turn on **Teach our own model**.

**Once, on the computer:** double-click **Set up our model** (in this folder, under `computer`). It says what it
will download and waits for you to press Enter:

| What | From | Size |
| --- | --- | --- |
| llama.cpp b11985 for Windows (CPU), the program that runs the model | github.com/ggml-org/llama.cpp | 24 MB |
| Qwen3 1.7B, Q4_K_M: the starting model, before any training | huggingface.co/unsloth/Qwen3-1.7B-GGUF | 1.1 GB |

It checks both against their known checksums, puts everything in `C:\Users\<you>\LightMoon\own-model`, and
starts our model with Windows from then on (quietly, at low priority). Until you've trained it, the starting
model shows how well an untrained small model does.

**Every few weeks, once a few hundred lessons have built up:**

1. Settings → *AI brain* → **Download training data** (on each device you collect on).
2. Open the training notebook on Kaggle:
   [Open in Kaggle](https://kaggle.com/kernels/welcome?src=https://github.com/rajeshpasalapudi1815-cyber/lightmoon/blob/main/trainer/lightmoon_train.ipynb)
   (or on kaggle.com: *Create* → *New notebook* → *File* → *Import notebook*, and choose
   `lightmoon_train.ipynb` from your `own-model` folder).
3. On the right: Accelerator **GPU T4 x2** and Internet **On**. *+ Add Input* → *Upload* → your training file(s).
4. Press **Run All**. With a thousand conversations it takes roughly one to two hours.
5. When it says **Done**, download the `.gguf` file from *Output*, then double-click **Start our model** in your
   `own-model` folder. It moves the new file in from Downloads and says when it's running.

Kaggle is free (about 30 hours of GPU a week); it asks you to verify a phone number once before it allows the
internet and the GPU. If Kaggle doesn't work for you,
[Google Colab](https://colab.research.google.com/github/rajeshpasalapudi1815-cyber/lightmoon/blob/main/trainer/lightmoon_train.ipynb)
runs the same notebook (*Runtime* → *Change runtime type* → **T4 GPU**, then *Run all*).

This laptop can't do the teaching itself: it has no graphics card that training tools can use. It runs the
model, but slowly: reading LightMoon's long instructions takes it 10 seconds to 2 minutes per answer. That's
fine for the comparison, which happens quietly in the background, but too slow to keep you waiting, so here our
model won't take over any kind of request however reliable it gets (the card says "too slow to hand over").
A faster computer, or the phone's own engine, can.

## What is kept, and what isn't

- The lessons stay on the device they were collected on (the latest 5,000, about 15 KB each), until you download
  them. *Delete all* removes them; everything else in LightMoon stays.
- Never kept: the phone's own data (other people's calls, messages and calendar events), any exchange where
  LightMoon used a phone tool, briefings given from phone data, and anything that looks like a one-time code,
  password or card number (it's replaced by `[code]` or `[number]`).
- The file you download does contain your conversations with LightMoon and what it knows about you (that's what
  it learns from). On Kaggle it stays private to your account; delete the dataset afterwards if you like.
- The comparison on the computer sends nothing anywhere: our model runs on the computer itself (127.0.0.1).
  The first time, Edge may ask whether LightMoon may reach devices on your network: allow it, that's our model.

## Is learning from the big AI allowed?

Yes, as far as the published terms go (this isn't legal advice):

- **gpt-oss** (the big AI) is released by OpenAI under the Apache 2.0 licence, with a usage policy that only asks
  you to follow the law. Neither limits what you do with its answers.
- **Groq's Services Agreement** says answers ("Outputs") are your data and you keep all rights in them (§1, §8.1),
  and that Groq itself may not train on them (§4.2). Its one related limit is not using the service to build
  something that competes with Groq's cloud service (§6.3(e)); a personal model for your own assistant isn't that.
  Models from other makers also carry their own terms (§4.1): for gpt-oss, the Apache 2.0 licence above.
- **Qwen3** (our model's starting point) is Apache 2.0 too, so the trained model is yours to use on any device.

## Why Qwen3 1.7B

| | Qwen3 1.7B (chosen) | Qwen2.5 1.5B Instruct | Gemma 3 1B |
| --- | --- | --- | --- |
| Tool calling | built in, the best of the three at this size | built in, good | no tool format of its own |
| Licence | Apache 2.0 | Apache 2.0 | Gemma terms (with a use policy) |
| File (Q4_K_M) | 1.1 GB | 1.0 GB | 0.8 GB |
| Room for LightMoon's long instructions | 32K tokens | 32K tokens | 32K tokens |
| Laptop CPU / phone | fine / fine | fine / a bit quicker | quickest |

LightMoon's work is mostly choosing the right tool and filling it in correctly, so tool calling decides it.
Qwen2.5 1.5B is the fallback: set `BASE_MODEL` in the notebook's first cell. Qwen3 can also "think aloud" before
answering; LightMoon turns that off (quicker, and the big AI's answers have no thinking to learn from).

## Files

```
README.md               this
lightmoon_train.ipynb   the training notebook (made by make_notebook.py; don't edit it by hand)
make_notebook.py        builds the notebook, with eval.py inside it
eval.py                 the agreement score: holds back one conversation in ten, scores a model on them
computer/
  Set up our model.cmd  downloads llama.cpp and the starting model (after asking), starts it with Windows
  Start our model.cmd   (re)starts it with the newest model; Stop our model.cmd stops it
  setup.ps1, start.ps1, stop.ps1
```

The app side is `docs/js/learning.js` (collecting, the export, the comparison and the hand-over), with one-line
hooks in `docs/js/brain.js`, and the two cards on the *AI brain* page of Settings.

## For developers

- **Training file:** one JSON object per line, OpenAI's fine-tuning format with tools:
  `{"messages": [system, ...history, user, assistant (tool_calls), tool, ..., assistant], "tools": [...]}`
  (`tools` is absent for spoken briefings). Tool-call arguments are JSON strings, as in the API. The system
  prompt is LightMoon's full prompt at the time, without its PHONE section.
- **Lessons:** each assistant message after the last user message is one lesson, learned from everything before
  it (`eval.cases`); the notebook masks everything but that answer. One conversation in ten (by a hash of its
  messages, `eval.is_held_out`) is never trained on, so before/after scores are honest.
- **The agreement rule** is in both `docs/js/learning.js` and `eval.py`; change both together.
- **Scoring a model on the computer:** with our model running, `python eval.py lightmoon-training-....jsonl`
  (`--all` to use every example, not only the held-back ones).
- **Serving:** `llama-server -m <model> --alias <name> --host 127.0.0.1 --port 8080 --jinja -c 12288 -np 1`.
  LightMoon reads `/v1/models` for the name (a name starting `lightmoon-YYYY-MM-DD` is shown as "last trained"),
  and asks `/v1/chat/completions` without streaming, with `chat_template_kwargs: {"enable_thinking": false}`.
- **The phone's offline brain** can use the same `.gguf` file with llama.cpp on Android. It was trained on
  LightMoon's full prompt and tool list (5,000 to 8,000 tokens), so it does best with the same prompt; reading
  that much takes a phone CPU a while, which caching the unchanging start of the prompt helps with.

## If something isn't right

- **The card says "Not running":** double-click *Start our model*; if it says it couldn't start, the end of
  `server.log` in the `own-model` folder says why. Another program using port 8080 is the usual reason.
- **Removing it:** *Stop our model*, delete the shortcut *LightMoon our model* from the Startup folder
  (Windows key + R, type `shell:startup`), and delete the `own-model` folder.
