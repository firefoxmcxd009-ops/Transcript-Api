// ============================================================
// server.js — Audio Transcription App (Render Free Tier Safe)
// Model: distil-whisper/distil-large-v3 via HF Inference API
// Author: Production-ready · No C++ bindings · 512MB RAM safe
// Fix v2: AbortController timeout + https keepAlive agent
// ============================================================

'use strict';

require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');

// ── Keep-alive HTTPS agent (prevents "fetch failed" on Render) ─
// Render free tier closes idle connections — keepAlive prevents this
const keepAliveAgent = new https.Agent({ keepAlive: true });

// ── Timeout constants ────────────────────────────────────────
// HF cold-start + transcription can take up to 2 min for large files
const HF_TIMEOUT_MS = 120_000; // 120 seconds

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Hugging Face config ──────────────────────────────────────
const HF_API_URL = 'https://api-inference.huggingface.co/models/distil-whisper/distil-large-v3';
const MAX_FILE_MB = 25;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// ── MIME types we accept ─────────────────────────────────────
const ALLOWED_MIMES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave',
  'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4',
  'audio/m4a', 'audio/x-m4a', 'audio/flac', 'audio/aac',
  'audio/x-aac', 'video/mp4', 'video/webm', 'video/ogg',
  'application/octet-stream', // some browsers send this for audio
]);

const ALLOWED_EXTENSIONS = /\.(mp3|wav|ogg|webm|m4a|flac|aac|mp4|opus)$/i;

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer: disk storage in /tmp/uploads ─────────────────────
// Using /tmp so Render's ephemeral FS doesn't bloat across restarts
const upload = multer({
  dest: path.join('/tmp', 'audio_uploads'),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const mimeOk = ALLOWED_MIMES.has(file.mimetype);
    const extOk  = ALLOWED_EXTENSIONS.test(file.originalname);
    if (mimeOk || extOk) {
      cb(null, true);
    } else {
      cb(new Error(`ទម្រង់ឯកសារ "${file.mimetype}" មិនត្រូវបានគាំទ្រ។ សូមប្រើ MP3, WAV, OGG, FLAC, M4A, WebM ឬ MP4`));
    }
  },
});

// ── Utility: safe file delete (won't throw if missing) ───────
function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.warn('[cleanup] Could not delete temp file:', filePath, e.message);
  }
}

// ── POST /api/transcript ─────────────────────────────────────
app.post('/api/transcript', upload.single('audio'), async (req, res) => {
  // ── Guard: no file ──────────────────────────────────────────
  if (!req.file) {
    return res.status(400).json({ error: 'សូមជ្រើសរើសឯកសារអូឌីយ៉ូ មុននឹងចុចប្ដូរ។' });
  }

  const tempPath = req.file.path;

  // ── Guard: HF_TOKEN missing ─────────────────────────────────
  const HF_TOKEN = process.env.HF_TOKEN;
  if (!HF_TOKEN) {
    safeDelete(tempPath);
    return res.status(500).json({
      error: 'HF_TOKEN មិនត្រូវបានកំណត់ក្នុង Environment Variables។ សូមបន្ថែមវានៅក្នុង Render Dashboard។',
    });
  }

  // ── Read file into memory then delete immediately ───────────
  let audioBuffer;
  try {
    audioBuffer = fs.readFileSync(tempPath);
  } catch (readErr) {
    safeDelete(tempPath);
    console.error('[read] Failed to read uploaded file:', readErr.message);
    return res.status(500).json({ error: `មិនអាចអានឯកសារ: ${readErr.message}` });
  }

  // Delete temp file RIGHT AWAY — before the HF network call
  // This keeps disk usage near-zero even if the API call takes a long time
  safeDelete(tempPath);

  // ── Call Hugging Face Inference API ─────────────────────────
  // AbortController gives us a hard timeout so Render never hangs forever
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);

  let hfResponse;
  try {
    hfResponse = await fetch(HF_API_URL, {
      method : 'POST',
      headers: {
        'Authorization'    : `Bearer ${HF_TOKEN}`,
        'Content-Type'     : req.file.mimetype || 'application/octet-stream',
        'X-Wait-For-Model' : 'true',   // Wait for cold-start model load instead of erroring
      },
      body   : audioBuffer,
      signal : controller.signal,      // ← hard timeout after 120s
      agent  : keepAliveAgent,         // ← prevents Render idle-connection drops
    });
  } catch (networkErr) {
    // AbortError = our own timeout fired
    if (networkErr.name === 'AbortError') {
      console.error('[hf-fetch] Request timed out after', HF_TIMEOUT_MS / 1000, 's');
      return res.status(504).json({
        error: `ការប្ដូរ Timeout បន្ទាប់ពី ${HF_TIMEOUT_MS / 1000} វិនាទី។ ឯកសារអូឌីយ៉ូអាចធំពេក ឬ HF API យឺត។ សូមសាកលក្បិនជាមួយឯកសារតូចជាង 5MB ហើយព្យាយាមម្ដងទៀត។`,
      });
    }
    console.error('[hf-fetch] Network error:', networkErr.message);
    return res.status(502).json({
      error: `មិនអាចភ្ជាប់ទៅ Hugging Face API: ${networkErr.message}. សូមព្យាយាមម្ដងទៀតក្នុងរយៈ 30 វិនាទី។`,
    });
  } finally {
    clearTimeout(timeoutId); // always clear the timer to prevent memory leak
  }

  // ── Parse HF response ────────────────────────────────────────
  let data;
  try {
    data = await hfResponse.json();
  } catch (parseErr) {
    const rawText = await hfResponse.text().catch(() => '(unreadable)');
    console.error('[hf-parse] Could not parse JSON. Raw:', rawText);
    return res.status(502).json({
      error: `Hugging Face បានឆ្លើយតបដោយទម្រង់មិនត្រឹមត្រូវ (HTTP ${hfResponse.status}). Raw: ${rawText.slice(0, 200)}`,
    });
  }

  // ── HF non-2xx status ────────────────────────────────────────
  if (!hfResponse.ok) {
    const errMsg = data?.error || JSON.stringify(data);
    console.error(`[hf-status] HTTP ${hfResponse.status}:`, errMsg);

    if (hfResponse.status === 503) {
      return res.status(503).json({
        error: `គំរូ AI កំពុងចាប់ផ្ដើម (Loading)។ សូមរង់ចាំ 20–30 វិនាទី ហើយព្យាយាមម្ដងទៀត។ (HF 503)`,
      });
    }
    if (hfResponse.status === 401) {
      return res.status(401).json({
        error: `HF_TOKEN មិនត្រឹមត្រូវ ឬអស់សិទ្ធ។ សូមបង្កើត Token ថ្មីនៅ huggingface.co/settings/tokens (HF 401)`,
      });
    }
    if (hfResponse.status === 429) {
      return res.status(429).json({
        error: `អ្នក​បាន​ប្ដូរ​ច្រើន​ពេក (Rate Limited)។ សូម​រង់​ចាំ​មួយ​ភ្លែត ហើយ​ព្យាយាម​ម្ដង​ទៀត (HF 429)`,
      });
    }
    return res.status(502).json({
      error: `Hugging Face API Error (HTTP ${hfResponse.status}): ${errMsg}`,
    });
  }

  // ── HF returned an error field in JSON body ──────────────────
  if (data?.error) {
    console.error('[hf-body-error]', data.error);
    return res.status(502).json({ error: `HF Model Error: ${data.error}` });
  }

  // ── Extract transcript text ──────────────────────────────────
  // distil-whisper returns: { text: "..." } or { chunks: [{ text: "..." }] }
  const transcriptText =
    data?.text ||
    (Array.isArray(data?.chunks)
      ? data.chunks.map((c) => c.text || '').join(' ').trim()
      : '');

  if (!transcriptText) {
    console.warn('[hf-empty] Empty transcript. Full response:', JSON.stringify(data));
    return res.status(422).json({
      error: 'ការប្ដូរមិនបានជោគជ័យ — AI បាន​ឆ្លើយ​តប​ប៉ុន្តែ​អត្ថបទ​ទទេ។ ឯកសារអូឌីយ៉ូអាចស្ងាត់ ឬខូច។',
    });
  }

  console.log(`[success] Transcribed ${req.file.originalname} — ${transcriptText.length} chars`);
  return res.status(200).json({ text: transcriptText });
});

// ── Multer / global error handler ───────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `ឯកសារធំជាង ${MAX_FILE_MB}MB ។ សូមប្រើឯកសារតូចជាងនេះ។`,
      });
    }
    return res.status(400).json({ error: `Upload Error: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ── Health check endpoint (Render uses this) ─────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Start server ─────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`✅ Audio Transcription Server started on port ${PORT}`);
  console.log(`   Model    : distil-whisper/distil-large-v3`);
  console.log(`   Timeout  : ${HF_TIMEOUT_MS / 1000}s per HF request`);
  console.log(`   HF_TOKEN : ${process.env.HF_TOKEN ? '✓ set' : '✗ MISSING — set in .env or Render env vars'}`);
});

// Raise Node's own HTTP server timeout above our fetch timeout
// so the response pipe never closes before we finish
server.setTimeout(HF_TIMEOUT_MS + 10_000); // 130s
