/* ============================================================
   Bajaj Finserv AI Platform · prototype server (zero dependencies, Node 18+)
   - serves the prototype page
   - /api/session : creates a live voice session (OpenAI GPT-Live over WebRTC,
                    or the Realtime API when VOICE_API=realtime) — the API key never leaves the server
   - /api/llm     : text model calls for the chat (Anthropic), key server-side
   - /api/health  : what is configured (never returns keys)
   - /api/metrics : voice timing / error log from the browser
   ============================================================ */
import http from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* ---- .env (optional) ---- */
const envPath = resolve(here, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m || line.trim().startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const E = (k, d) => (process.env[k] ?? d);
const PORT = Number(E("PORT", 3000));
const HOST = E("HOST", process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const VOICE_API = E("VOICE_API", "live");                       // "live" (GPT-Live) | "realtime"
const CFG = {
  liveModel: E("LIVE_MODEL", "gpt-live-1"),
  liveDelegateModel: E("LIVE_DELEGATE_MODEL", "gpt-5.6-terra"),
  liveVoice: E("LIVE_VOICE", "nira"),
  realtimeModel: E("REALTIME_MODEL", "gpt-realtime-2.1"),
  realtimeVoice: E("REALTIME_VOICE", "marin"),
  visionModel: E("VISION_MODEL", "gpt-4.1-mini"),
  realtimeTranscribe: E("REALTIME_TRANSCRIBE_MODEL", "gpt-4o-transcribe"),
  anthropicModel: E("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
  anthropicFast: E("ANTHROPIC_FAST_MODEL", "claude-haiku-5-5"),
};
const PAGE = resolve(here, E("PAGE_FILE", "index.html"));

/* ---- voice behaviour + tools (owned by the server; the page only adds live context) ---- */
/* Voice behaviour comes from voice-prompt.md (the Blu B2B Easy EMI speech-to-speech prompt). Edit that file to change how Blu talks. */
const PROMPT_FILE = resolve(here, E("VOICE_PROMPT_FILE", "voice-prompt.md"));
function loadVoicePrompt(){
  let t = existsSync(PROMPT_FILE) ? readFileSync(PROMPT_FILE, "utf8") : "You are Blu, Bajaj Finserv's Easy EMI voice assistant. Be brief and warm.";
  t = t.split(/\n## Implementation notes/)[0];                       // build notes are not for the model
  t = t.replace(/^# .*\n+(\*[^\n]*\*\n+)?(---\n+)?/, "");          // drop the document title block
  return t.trim() + "\n\nPlaceholders in double braces that are not filled below come from the LIVE CONTEXT FROM THE APP and tool results; never say a placeholder aloud.";
}
const VOICE_INSTRUCTIONS = loadVoicePrompt();
const fillVars = (t, v = {}) => t.replace(/\{\{(first_name|mobile_last4)\}\}/g, (m, k) => v[k] ? String(v[k]).slice(0, 40) : m);

const TOOLS = [
  { name:"search_products", description:"Search the catalogue and show product cards on screen. Use for discovery, budget, brand or 'cheaper/better options' requests.",
    parameters:{ type:"object", properties:{ category:{ type:"string", enum:["mobile","tv","fridge","washer","ac","laptop","furniture","ebike"] }, brand:{ type:"string" }, budget_max:{ type:"number", description:"Upper budget in rupees, e.g. 45000" }, priority:{ type:"string", description:"What matters most, e.g. camera, battery, screen, lowest_emi" }, cheaper_than_current:{ type:"boolean" } }, required:[] } },
  { name:"compare_products", description:"Compare 2-3 products on screen. Use positions ('first two') or SKU ids returned by search_products.",
    parameters:{ type:"object", properties:{ sku_ids:{ type:"array", items:{ type:"string" } }, positions:{ type:"array", items:{ type:"integer" }, description:"1-based positions in the last product list" } }, required:[] } },
  { name:"select_product", description:"Select the product the customer chose (by SKU id, position, or name as said).",
    parameters:{ type:"object", properties:{ sku_id:{ type:"string" }, position:{ type:"integer" }, name:{ type:"string" } }, required:[] } },
  { name:"start_easy_emi", description:"Start the Easy EMI eligibility journey for the selected product. Returns the next step the customer must do.",
    parameters:{ type:"object", properties:{}, required:[] } },
  { name:"journey_step", description:"Pass what the customer said to the current journey step, in their words. Works for everything said aloud: confirming the product, 'proceed' for the credit bureau, 'use the sample' Aadhaar, edits ('my date of birth is 21 September 1990', 'PIN code 411001', 'gender is male', 'edit details'), 'I agree' (verbal consent; the T&C must have been opened), 'approve' for Account Aggregator, location 'yes', the Aadhaar OTP digits, EMI plan choices, stores, add-ons ('1-year warranty', 'remove warranty', 'add life cover'), 'change plan', 'show more stores'. Never ask the customer to type or tap what they already said.",
    parameters:{ type:"object", properties:{ answer:{ type:"string", description:"The customer's choice in plain words" } }, required:["answer"] } },
  { name:"get_status", description:"Get the current screen state: stage, selected product, what the journey is waiting for, suggested next actions.",
    parameters:{ type:"object", properties:{}, required:[] } },
  { name:"other_product", description:"Open another Bajaj Finserv product journey preview (EMI_CARD, PL personal loan, GL gold loan) when the customer asks.",
    parameters:{ type:"object", properties:{ product:{ type:"string", enum:["EMI_CARD","PL","GL"] }, amount:{ type:"number" } }, required:["product"] } },
  { name:"talk_to_person", description:"Prepare a hand-off to a person with the conversation context.",
    parameters:{ type:"object", properties:{ reason:{ type:"string" } }, required:[] } }
];

/* ---- helpers ---- */
const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "Permissions-Policy": "microphone=(self)" }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
const readBody = (req, limit) => new Promise((ok, bad) => { let n = 0; const chunks = []; req.on("data", c => { n += c.length; if (n > limit) { bad(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); }); req.on("end", () => ok(Buffer.concat(chunks).toString("utf8"))); req.on("error", bad); });
const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const timeoutSignal = ms => AbortSignal.timeout(ms);

/* ---- session creation ---- */
async function createLive(sdp, context, vars){
  const body = {
    session: {
      model: CFG.liveModel,
      instructions: (fillVars(VOICE_INSTRUCTIONS, vars) + "\n\nLIVE CONTEXT FROM THE APP:\n" + context).slice(0, 60000),
      audio: { output: { voice: CFG.liveVoice } },
      delegation: { type: "responses", responses: {
        model: CFG.liveDelegateModel,
        instructions: "You operate the Bajaj Finserv app for Blu's spoken conversation (B2B Easy EMI). Call the app's tools to search, compare, select products and run the journey: credit bureau pre-fill, Aadhaar, limit-check consent, approval, Account Aggregator, No Cost EMI plan, closest partner store, add-ons, summary. Keep results short and grounded in tool output. Never quote product prices or offers; fees are inside the EMI. Pass every spoken answer, edit and consent to journey_step in the customer's words (verbal consent is valid); never ask them to type or tap what they said. Voice journeys run as the agent flow: after each tool result, move on to the next step.",
        tools: TOOLS.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
        tool_choice: "auto"
      } }
    },
    transport: { type: "webrtc", sdp }
  };
  /* background-noise reduction on the customer's mic; if this account's GPT-Live doesn't accept the setting, retry without it */
  body.session.audio.input = { noise_reduction: { type: "near_field" } };
  const post = (b) => fetch("https://api.openai.com/v1/live/sessions", { method: "POST", signal: timeoutSignal(20000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(b) });
  let r = await post(body), text = await r.text();
  if (r.status === 400 && /noise|input/i.test(text)) { delete body.session.audio.input; log("noise_reduction not accepted by GPT-Live; retrying without it"); r = await post(body); text = await r.text(); }
  if (!r.ok) throw Object.assign(new Error(text.slice(0, 400)), { status: r.status });
  const j = JSON.parse(text);
  return { api: "live", session_id: j.session?.id, sdp: j.transport?.sdp };
}
/* what the customer says is transcribed in Roman script (English / Hinglish), with the words this journey uses */
const TRANSCRIBE_PROMPT = "Transcribe exactly what the customer says, word for word, in the language they actually speak. Use Roman (English) letters only, never Devanagari or Urdu script. Do not translate. Names that may come up: Blu, Bajaj Finserv, Easy EMI, Aadhaar, PAN, OTP, T&C, Account Aggregator, iPhone, Samsung Galaxy, Redmi, OnePlus, Nothing Phone, Croma, Vijay Sales.";
async function createRealtime(sdp, context, vars){
  const session = {
    type: "realtime", model: CFG.realtimeModel,
    instructions: (fillVars(VOICE_INSTRUCTIONS, vars) + "\n\nLIVE CONTEXT FROM THE APP:\n" + context).slice(0, 60000),
    /* create_response:false — the app hears each finished sentence first, acts on the screen, then tells Blu what to say;
       Blu answers freely only when the app has nothing to do. This keeps voice and screen in step. */
    audio: { input: { transcription: { model: CFG.realtimeTranscribe, prompt: TRANSCRIBE_PROMPT }, noise_reduction: { type: "near_field" }, turn_detection: { type: "semantic_vad", eagerness: "low", create_response: false, interrupt_response: true } }, output: { voice: CFG.realtimeVoice } },
    tools: TOOLS.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
    tool_choice: "auto"
  };
  const post = () => { const fd = new FormData(); fd.set("sdp", sdp); fd.set("session", JSON.stringify(session)); return fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", signal: timeoutSignal(20000), headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: fd }); };
  let r = await post(), text = await r.text();
  if (r.status === 400 && /transcri|prompt|model/i.test(text)) { log("transcription settings not accepted; retrying with gpt-4o-mini-transcribe"); session.audio.input.transcription = { model: "gpt-4o-mini-transcribe", prompt: TRANSCRIBE_PROMPT }; r = await post(); text = await r.text(); }
  if (r.status === 400 && /transcri|prompt/i.test(text)) { session.audio.input.transcription = { model: "gpt-4o-mini-transcribe" }; r = await post(); text = await r.text(); }
  if (!r.ok) throw Object.assign(new Error(text.slice(0, 400)), { status: r.status });
  return { api: "realtime", session_id: (r.headers.get("location") || "").split("/").pop() || null, sdp: text };
}

/* ---- text model (Anthropic) ---- */
async function anthropic(prompt, tier, images){
  const content = [];
  for (const d of (images || [])) { const m = String(d).match(/^data:([^;]+);base64,(.*)$/); if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1] === "image/jpg" ? "image/jpeg" : m[1], data: m[2] } }); }
  content.push({ type: "text", text: prompt });
  const models = tier === "quick" ? [CFG.anthropicFast, "claude-haiku-4-5"] : [CFG.anthropicModel, "claude-sonnet-4-5"];
  let last;
  for (const model of models) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: timeoutSignal(60000),
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: "user", content }] }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    last = Object.assign(new Error(j.error?.message || ("HTTP " + r.status)), { status: r.status });
    if (!(r.status === 404 || /model/i.test(j.error?.message || ""))) break;
  }
  throw last;
}

/* ---- document reading (Aadhaar / PAN photo → fields) with the OpenAI key; the photo is not stored ---- */
async function openaiVision(prompt, images){
  const content = [{ type: "input_text", text: prompt }];
  for (const d of (images || []).slice(0, 4)) if (/^data:image\//.test(String(d))) content.push({ type: "input_image", image_url: String(d), detail: "high" });
  let last;
  for (const model of [CFG.visionModel, "gpt-4.1-mini", "gpt-4o-mini"]) {
    const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", signal: timeoutSignal(60000),
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [{ role: "user", content }], store: false }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j.output_text || (j.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("");
    last = Object.assign(new Error(j.error?.message || ("HTTP " + r.status)), { status: r.status });
    if (!(r.status === 404 || r.status === 400 && /model/i.test(j.error?.message || ""))) break;
  }
  throw last;
}

/* ---- routes ---- */
const AUTH = process.env.DEMO_PASSWORD ? "Basic " + Buffer.from((process.env.DEMO_USER || "demo") + ":" + process.env.DEMO_PASSWORD).toString("base64") : null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (AUTH && req.headers.authorization !== AUTH) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Bajaj Finserv AI prototype"' }); return res.end("Password required"); }
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (!existsSync(PAGE)) return send(res, 200, "<p>Put the prototype file next to server.mjs as index.html.</p>", "text/html");
      return send(res, 200, await readFile(PAGE, "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { llm: !!process.env.ANTHROPIC_API_KEY, live: !!process.env.OPENAI_API_KEY, vision: !!process.env.OPENAI_API_KEY, voiceApi: VOICE_API, voice: VOICE_API === "realtime" ? CFG.realtimeVoice : CFG.liveVoice, model: VOICE_API === "realtime" ? CFG.realtimeModel : CFG.liveModel });
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      if (!sameOrigin(req)) return send(res, 403, { code: "bad_origin" });
      if (!process.env.OPENAI_API_KEY) return send(res, 503, { code: "no_key", error: "Set OPENAI_API_KEY in .env (or your host's environment) and restart the server." });
      const b = JSON.parse(await readBody(req, 200000) || "{}");
      if (typeof b.sdp !== "string" || !b.sdp.trim()) return send(res, 400, { code: "no_sdp" });
      const t0 = Date.now();
      try {
        const out = await (VOICE_API === "realtime" ? createRealtime : createLive)(b.sdp, String(b.context || "").slice(0, 40000), b.vars && typeof b.vars === "object" ? b.vars : {});
        log("voice session created", out.api, out.session_id, (Date.now() - t0) + "ms");
        return send(res, 201, out);
      } catch (e) {
        log("voice session failed", VOICE_API, e.status, e.message);
        return send(res, e.status && e.status < 600 ? e.status : 502, { code: "session_failed", status: e.status || null, error: e.message.slice(0, 300) });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/llm") {
      if (!sameOrigin(req)) return send(res, 403, { code: "bad_origin" });
      if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { code: "no_key" });
      const b = JSON.parse(await readBody(req, 25e6) || "{}");
      try { return send(res, 200, { text: await anthropic(String(b.prompt || ""), b.tier, b.images) }); }
      catch (e) { log("llm failed", e.status, e.message); return send(res, 502, { code: e.status === 401 ? "bad_key" : "api_error", detail: String(e.message).slice(0, 200) }); }
    }
    if (req.method === "POST" && url.pathname === "/api/vision") {
      if (!sameOrigin(req)) return send(res, 403, { code: "bad_origin" });
      if (!process.env.OPENAI_API_KEY) return send(res, 503, { code: "no_key" });
      const b = JSON.parse(await readBody(req, 25e6) || "{}");
      try { return send(res, 200, { text: await openaiVision(String(b.prompt || ""), b.images) }); }
      catch (e) { log("vision failed", e.status, e.message); return send(res, 502, { code: e.status === 401 ? "bad_key" : "api_error", detail: String(e.message).slice(0, 200) }); }
    }
    if (req.method === "POST" && url.pathname === "/api/metrics") {
      const b = await readBody(req, 20000);
      log("metric", b);
      appendFile(resolve(here, "voice-metrics.log"), new Date().toISOString() + " " + b + "\n").catch(() => {});
      return send(res, 204, "", "text/plain");
    }
    send(res, 404, { code: "not_found" });
  } catch (e) { log("error", e.message); send(res, e.status || 500, { code: "server_error" }); }
});
server.listen(PORT, HOST, () => {
  log(`Bajaj Finserv AI prototype on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  log(`voice prompt: ${existsSync(PROMPT_FILE) ? PROMPT_FILE.split("/").pop() : "built-in fallback"} (${VOICE_INSTRUCTIONS.length} chars)`);
  log(`voice: ${VOICE_API} · OpenAI key ${process.env.OPENAI_API_KEY ? "set" : "MISSING"} · Anthropic key ${process.env.ANTHROPIC_API_KEY ? "set" : "missing (chat uses rule engine)"}`);
});
