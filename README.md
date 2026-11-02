# Bajaj Finserv AI Platform: prototype with live voice

This is the existing prototype, with the same design, panels and journeys, plus **genuine live voice**: speech to speech over WebRTC with OpenAI GPT-Live, connected to the same agents, cards and journey as the chat.

## Files

| File | What it is |
|---|---|
| `index.html` | The prototype page. It is the same page as the Claude link; live voice switches on when it is served by this server. |
| `server.mjs` | The backend. It has no dependencies and needs Node 18.17 or newer. It holds the API keys, creates the voice sessions, proxies the text model and logs voice timings. |
| `voice-prompt.md` | **How Blu talks in live voice**: the B2B Easy EMI speech-to-speech prompt. The server loads it at start (edit and restart to change Blu's behaviour). |
| `.env.example` | Template for the API keys and settings. Copy it to `.env`. |
| `package.json` | Start script, used by hosting services. |

## 1. Run it on your laptop (microphone works on localhost)

1. Install **Node.js LTS** from nodejs.org.
2. Unzip this folder and open Terminal in it.
3. Create the settings file:
   ```
   cp .env.example .env
   ```
4. Open `.env` and paste your **OPENAI_API_KEY**. Optionally add your **ANTHROPIC_API_KEY**.
5. Start the server:
   ```
   npm start
   ```
   You should see:
   `voice: live · OpenAI key set`
6. Open **http://localhost:3000** in Chrome or Edge.
7. Tap the waveform and allow the microphone once. Then just talk.

The prototype must be opened through the server, at `http://localhost:3000`. Opening `index.html` directly can't create a live session.

## 2. Host it for phones (HTTPS)

iPhone and Android need an HTTPS link. Render's free plan is one option:

1. Put this folder in a **private** GitHub repo, but **don't upload `.env`**.
2. On render.com, choose New → Web Service → your repo.
   - Runtime: Node
   - Build command: *(empty)*
   - Start command: `npm start`
3. Under **Environment**, add:
   - `OPENAI_API_KEY`
   - `ANTHROPIC_API_KEY` (optional)
   - `DEMO_PASSWORD` (recommended, so strangers can't use your key)
4. Deploy. The `https://…onrender.com` link is fixed and works on mobile. Updating means pushing the new `index.html` to the repo.

Free Render services go to sleep when idle, so the first open can take about 30–60 seconds.

## 3. How the live voice works

```
Browser (index.html)                               server.mjs                         OpenAI
 mic ──► RTCPeerConnection ── SDP offer ─────────► POST /api/session ──────────────► POST /v1/live/sessions
                                                    (adds instructions + tools,        (model gpt-live-1,
 speaker ◄── remote audio track ◄── SDP answer ◄─── returns only session id + SDP) ◄── transport webrtc)
 data channel "oai-events" ◄──────────────────────── live events (transcripts, tool calls) ──────────────►
```

**Security**
- The OpenAI key stays on the server. The browser never sees a key, not even a short-lived one, because the server makes the session call and returns only the SDP answer.
- The server owns the voice instructions and the tool list. The page adds only live context: screen state, products on screen and recent conversation.

**Transcripts**
- The customer's speech arrives as `session.input_transcript.delta` and Blu's as `session.output_transcript.delta`.
- Both appear as chat bubbles and go into the same conversation history the typed chat uses.

**Tools**
- Tools run through GPT-Live's Responses delegation (`delegation.responses.tools`). The tools are `search_products`, `compare_products`, `select_product`, `start_easy_emi`, `journey_step`, `get_status`, `other_product` and `talk_to_person`.
- Calls arrive inside `response.event`, as `response.output_item.done` with a function call. The page runs the same action executor and journey as the chat (cards, comparison, approval, plans, stores and add-ons all appear the same way).
- The page replies with `response.item.create` (`function_call_output`), then `response.create`.

**Typed messages and chip taps during voice**
- Typing (keyboard button in the voice bar) or tapping a chip while voice is on goes into the live session as `session.instructions.append`, so Blu answers it by voice in the same context.
- Page-side steps, such as a typed OTP, are reported with `session.commentary.append`.

**Safety**
- OTP, PAN/Aadhaar and the consent "I agree" are refused when they come from speech (`journey_step` returns `refused`). The customer must type or tap them.

**Interruptions**
- GPT-Live is full duplex, so the customer can talk over Blu.
- The page detects the interruption from the echo-cancelled microphone level while Blu's audio is playing. It shows INTERRUPTED and measures how quickly Blu goes quiet.

**Reconnects**
- If the connection drops, the page reconnects up to 3 times with a new session.
- The new session is given the conversation so far and the screen state, so nothing restarts.

### Fallback engine: OpenAI Realtime API

If GPT-Live tool calls don't reach the browser on your account, set `VOICE_API=realtime` in `.env` and restart. That switches the whole voice layer to the Realtime API (model `gpt-realtime-2.1`, `POST /v1/realtime/calls` via the server) with the same tools and UI. The two are never mixed in one session.

### Voice states (orb)

The voice states are IDLE, CONNECTING, LISTENING, USER_SPEAKING, PROCESSING, AI_SPEAKING, INTERRUPTED, RECONNECTING, ERROR and ENDED.

They are driven by connection events and **measured** audio levels: the microphone, and Blu's incoming audio. The Realtime engine also uses its explicit speech events. The orb's size follows the live audio level.

### Measurements

Panel C → *Live context & NBA* → **Live voice** shows the median values. Every event is also logged in the browser console as `[live-voice]` and in `voice-metrics.log` on the server.
- Connect time: from tapping the waveform to `session.started`.
- Speech end to first audio.
- Interrupt to silence.
- Failures, reconnects and playback errors.

## 4. Browser and device compatibility

| Browser | Expected | Tested |
|---|---|---|
| Desktop Chrome | Supported (WebRTC + mic on localhost/HTTPS) | Client logic tested in Chrome with simulated audio; real OpenAI audio not tested (no key/mic in the build environment) |
| Desktop Edge | Supported (Chromium; doesn't use Edge's speech service) | Not yet tested on a real device |
| iPhone Safari | Supported on HTTPS; mic prompt on first tap; audio starts from the tap | Not yet tested on a real device |
| Android Chrome | Supported on HTTPS | Not yet tested on a real device |
| Claude viewer | Live voice not possible (no microphone access); shows the reason; text and basic dictation still work | Tested |
| `index.html` opened as a file | Live voice not possible (no server); shows how to run it | Tested |

## 5. QA report

Simulated tests in Chrome: a fake OpenAI peer (a real WebRTC connection, data channel and audio track in the page) and a controllable fake microphone.

| # | Test | Result |
|---|---|---|
| 1 | Start a voice session (CONNECTING → LISTENING on `session.started`) | Pass |
| 2 | Customer speech drives USER_SPEAKING → PROCESSING; Hinglish transcript shown | Pass |
| 3 | Voice tool `search_products` (Samsung TV, ₹45,000) shows cards; entities set; output returned to the model | Pass |
| 4 | Blu's incoming audio → AI_SPEAKING; transcript shown | Pass |
| 5 | Barge-in while Blu speaks → INTERRUPTED; interruption time measured | Pass |
| 6 | Voice → text: typed message joins the live session; shared history | Pass |
| 7 | Compare "first two" and select "second one" by voice tools | Pass |
| 8 | Easy EMI started by voice → OTP step; selected product kept | Pass |
| 9 | OTP spoken → refused, must be typed; typed OTP accepted and the live session notified | Pass |
| 10 | Network drop → RECONNECTING → new session with conversation context | Pass |
| 11 | End (sends `session.close`) and restart | Pass |
| 12 | Microphone denied → ERROR with instructions; text keeps working | Pass |
| 13 | Realtime engine variant: speech events, barge-in, tool output, typed text | Pass |
| 14 | Existing journeys (agent mode end to end) unchanged | Pass |
| 15 | Server: health, missing-key 503, password protection | Pass |

**Still to run with your key, on a real device:**
- audible responses and voice quality
- English, Hindi and Hinglish recognition
- actual latency numbers
- whether GPT-Live tool calls arrive over WebRTC on your account
- iPhone and Android behaviour

The page measures and logs these as you test.

## 6. Latency

**Not measured yet against the real service.** Numbers from the simulated run say nothing about OpenAI's real latency, so none are reported here. Run a session and read Panel C → Live voice, or `voice-metrics.log`.

## 7. Known limitations

- **Unconfirmed in the docs:** that GPT-Live delegated tool calls work over the browser WebRTC data channel. If cards don't appear when you ask by voice, switch to `VOICE_API=realtime`.
- **Echo:** user speech and interruptions are detected from the echo-cancelled microphone level. Very loud speakers without headphones can occasionally be read as the customer talking.
- **Hindi voice:** `nira` is the only Hindi voice OpenAI lists. Hinglish isn't explicitly documented, so test it, and change `LIVE_VOICE` if you prefer an English voice.
- **Simulated back end:** the catalogue, BRE, plans and stores are still the prototype's simulated APIs. Live voice drives them; it doesn't connect to real Bajaj systems.
- **Cost:** live audio is billed per minute by OpenAI. Use `DEMO_PASSWORD` on any public link.
- **No silent fallback:** "Basic voice (browser speech, not live)" is offered only as an explicit, labelled choice when live voice is unavailable.
