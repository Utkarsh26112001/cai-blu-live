# What changed (v2: Blu recommends, the customer decides)

## Why the bot moved forward by itself
1. **Any sentence that started with or contained a yes-word counted as a yes.** "Okay so what does it fetch?", "I'm not sure", "what is Account Aggregator?" all moved the journey on. A bare "ok" even counted as T&C consent.
2. **Store step defaulted to the closest store.** A bare "okay" to "which one would you like?" (or any unrecognised reply) picked store #1.
3. **The 1-year warranty was added before the customer was asked.**
4. **The voice prompt told the model to "move straight to the next step"** and ran voice as the agent flow, so Blu pre-announced and talked past decision points.

## Fixes (index.html)
- New clean-answer check (`cleanYes`, `HEDGE`): a yes only counts if it is short and is not a question, "yes, but…", hesitation or a longer sentence that merely starts with "okay". Chip taps are still always explicit.
- T&C consent now needs explicit words ("I agree", "I accept", "sahmat hoon"…). A bare "ok / yes / haan" makes Blu say what it needs instead.
- Nods ("hmm", "achha", "I see") are never answers. A bare "ok" said over Blu's own consent question makes Blu re-ask rather than take consent.
- A bare "ok" to "which one?" now makes Blu ask "Vijay Sales or Croma?" and the store is never picked by default.
- The meaning-check model can no longer turn a hedged reply, or a bare "ok", into a yes or consent.
- Warranty is offered ("Would you like it, or skip?") and added only on the customer's yes.
- Lines the page hands to Blu are now spoken in natural words (facts, numbers and the closing question unchanged) instead of read verbatim, and Blu stops after a question.

## Prompt (voice-prompt.md) and server.mjs
- New first rule: Blu recommends, the customer decides. Ask, then stop. Never "I've gone ahead".
- Removed "move straight to the next step", "you decide and keep going", "after each choice you make…".
- Added a natural-speech section (react to what they said, vary openers, don't read the screen, give room, handle interruptions and corrections) and a "how you think" section (use what you know, notice mismatches, answer the real question, admit what you don't know).
- Delegation instructions in server.mjs no longer say "after each tool result, move on".

## Not changed
- Store lookup still uses the Aadhaar PIN code without a location prompt in voice.
- Typed Agent mode (non-voice) still auto-adds the warranty and auto-confirms details, as designed there.
