// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import XLSX from "xlsx";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

const AUTOCAB_KEY    = process.env.AUTOCAB_KEY || "";
const WEBHOOK_TOKEN  = process.env.WEBHOOK_TOKEN || "";
const STATUS_FILE    = process.env.STATUS_FILE || "./status.json";

// HOW LONG a ping keeps a vehicle ONLINE (minutes) before timing out
const PING_TIMEOUT_MINUTES = Number(process.env.PING_TIMEOUT_MINUTES || 10);
const OFFLINE_TIMEOUT_MS   = PING_TIMEOUT_MINUTES * 60 * 1000;

// Permit details are read from Autocab's single-vehicle endpoint.
// Cache results to avoid requesting every vehicle on every browser refresh.
const PERMIT_CACHE_TTL_MS = Number(process.env.PERMIT_CACHE_TTL_MS || 10 * 60 * 1000);
const PERMIT_DETAIL_CONCURRENCY = Math.max(1, Number(process.env.PERMIT_DETAIL_CONCURRENCY || 6));
const permitDetailCache = new Map(); // vehicleId -> { expiresAt, motExpiryDate }

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production" && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(cors({ origin: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  if (req.path.toLowerCase().includes("status") ||
      req.path.toLowerCase().includes("location") ||
      req.path.toLowerCase().includes("shiftchange") ||
      req.path.toLowerCase().includes("webhook")) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  }
  next();
});

/**
 * onlineMap: callsign -> {
 *   lastPingAt: ISO,
 *   updatedAt: ISO,
 *   driverStatusCode: string | null,   // raw VehicleStatus (BusyMeterOff, …)
 *   driverStatusLabel: string | null,  // friendly label for UI
 *   driverStatus: string | null,       // alias of driverStatusLabel (backwards compat)
 *   explicitOnline: boolean|null       // true = on shift / tracking, false = off shift
 * }
 */
let onlineMap = new Map();

// --- DEBUG: store last webhook payloads ---
let lastHackneyLocationPayload = null;
let lastStatusPayload = null;
let lastShiftChangePayload = null;

function debugLog(label, payload) {
  console.log(`\n===== ${label} @ ${new Date().toISOString()} =====`);
  try {
    const str = JSON.stringify(payload, null, 2);
    if (str.length > 5000) console.log(str.substring(0, 5000) + " ... [TRUNCATED]");
    else console.log(str);
  } catch (err) {
    console.log("Could not stringify payload:", err.message);
    console.log(payload);
  }
}

// ---------- Persistence ----------
function loadStatusFromDisk() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
      onlineMap = new Map(raw.map(([k, v]) => [k, v]));
      console.log(`Loaded ${onlineMap.size} records from ${STATUS_FILE}`);
    } else {
      console.log(`No ${STATUS_FILE}, starting clean`);
    }
  } catch (e) {
    console.warn("loadStatusFromDisk failed:", e.message);
  }
}

let saveTimer;
function saveStatusToDisk() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const arr = Array.from(onlineMap.entries());
      fs.writeFileSync(STATUS_FILE, JSON.stringify(arr), "utf8");
    } catch (e) {
      console.warn("saveStatusToDisk failed:", e.message);
    }
  }, 500);
}

loadStatusFromDisk();

const normKey = (s) => String(s || "").trim().toUpperCase();

// Helper: is incoming timestamp newer than existing?
function isNewerTimestamp(incomingIso, existingIso) {
  if (!incomingIso) return false;
  const inMs = Date.parse(incomingIso);
  if (!Number.isFinite(inMs)) return false;
  if (!existingIso) return true;
  const exMs = Date.parse(existingIso);
  if (!Number.isFinite(exMs)) return true;
  return inMs >= exMs;
}

// ---------- ONLINE LOGIC ----------
function computeOnline(rec) {
  if (!rec) return false;

  const code = rec.driverStatusCode || "";
  const statusLower = (rec.driverStatusLabel || rec.driverStatus || "").toString().toLowerCase();

  // Hard offline states
  if (
    code === "NotWorking" ||
    statusLower.includes("not working") ||
    statusLower.includes("off shift") ||
    statusLower.includes("off-duty") ||
    statusLower.includes("off duty") ||
    statusLower.includes("logged off") ||
    statusLower.includes("signed off") ||
    statusLower.includes("not on shift")
  ) {
    return false;
  }

  // Must be explicitly online
  if (rec.explicitOnline !== true) return false;

  // Heartbeat: lastPingAt OR updatedAt
  const heartbeatIso = rec.lastPingAt || rec.updatedAt || null;
  if (!heartbeatIso) return false;

  const t = Date.parse(heartbeatIso);
  if (!Number.isFinite(t)) return false;

  const age = Date.now() - t;
  if (age > OFFLINE_TIMEOUT_MS) return false;

  return true;
}

// Build a payload for API/SSE that is consistent with frontend "onlineFor()":
// If computeOnline(rec) is false, we force the payload status to OFFLINE/NotWorking
// (without mutating the stored record).
function statusPayload(callsign, rec) {
  const online = computeOnline(rec);

  let driverStatus = rec?.driverStatus || rec?.driverStatusLabel || null;
  let driverStatusCode = rec?.driverStatusCode || null;

  if (!online) {
    driverStatus = "OFFLINE";
    driverStatusCode = "NotWorking";
  }

  return {
    callsign,
    online,
    updatedAt: rec?.updatedAt || null,
    driverStatus,
    driverStatusCode,
  };
}

// ---------- Common helpers ----------
function extractCallsignGeneric(obj) {
  const direct =
    obj?.callsign ??
    obj?.callSign ??
    obj?.code ??
    obj?.mdtId ??
    obj?.mdtID ??
    obj?.vehicleCode ??
    obj?.driverCode ??
    null;

  if (direct) return direct;

  const d = obj?.Driver || obj?.driver || {};
  const v = obj?.Vehicle || obj?.vehicle || {};

  return (
    d?.Callsign ?? d?.callsign ?? d?.callSign ??
    v?.Callsign ?? v?.callsign ?? v?.callSign ??
    null
  );
}

function coercePayloadToArray(body) {
  const b = body || {};
  if (Array.isArray(b)) return b;
  if (Array.isArray(b.VehicleTracks)) return b.VehicleTracks;
  if (Array.isArray(b.data)) return b.data;
  if (Array.isArray(b.items)) return b.items;
  if (Array.isArray(b.Shifts)) return b.Shifts;
  if (Array.isArray(b.Events)) return b.Events;
  return [b];
}

// VehicleStatus → friendly label (backend only; frontend now does its own shortening)
function vehicleStatusLabel(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  if (raw === "Clear") return "Clear";

  if (raw === "BusyMeterOff" || raw === "BusyMeterOffAccount") return "Dispatched";
  if (raw === "BusyMeterOnFromMeterOffCash" || raw === "BusyMeterOnFromMeterOffAccount") return "Picked up";
  if (raw === "BusyMeterOnFromClear") return "Street Booking";
  if (raw === "JobOffered") return "Offering Job";

  const lower = s.toLowerCase();
  if (lower.startsWith("busy")) return "Busy";

  return s; // fallback
}

function shiftStatusLabel(rawStatus, eventType, subType, item) {
  const s   = (rawStatus || "").toString().toLowerCase();
  const evt = (eventType || "").toString().toLowerCase();
  const sub = (subType || "").toString().toLowerCase();

  const onShiftBool =
    typeof item?.IsOnShift === "boolean" ? item.IsOnShift :
    typeof item?.OnShift   === "boolean" ? item.OnShift   :
    typeof item?.onShift   === "boolean" ? item.onShift   :
    null;

  if (onShiftBool === true)  return "On Shift";
  if (onShiftBool === false) return "Off Shift";

  if (s.includes("break")) return "On Break";

  if (
    s.includes("start") ||
    s.includes("on shift") ||
    s.includes("logged in") ||
    s.includes("loggedon") ||
    s.includes("signed on") ||
    evt.includes("shiftstart") ||
    sub === "started"
  ) return "On Shift";

  if (
    s.includes("end") ||
    s.includes("off shift") ||
    s.includes("logged out") ||
    s.includes("loggedoff") ||
    s.includes("signed off") ||
    (s.includes("off") && !s.includes("offline status ignored")) ||
    evt.includes("shiftend") ||
    sub === "ended"
  ) return "Off Shift";

  if (rawStatus) return String(rawStatus);
  if (evt)       return `Shift: ${eventType}`;
  if (sub)       return `Shift: ${subType}`;
  return null;
}

function inferExplicitOnlineFromShift(rawStatus, eventType, subType, item) {
  const s   = (rawStatus || "").toString().toLowerCase();
  const evt = (eventType || "").toString().toLowerCase();
  const sub = (subType || "").toString().toLowerCase();

  const onShiftBool =
    typeof item?.IsOnShift === "boolean" ? item.IsOnShift :
    typeof item?.OnShift   === "boolean" ? item.OnShift   :
    typeof item?.onShift   === "boolean" ? item.onShift   :
    null;
  if (onShiftBool !== null) return onShiftBool;

  if (
    s.includes("start") ||
    s.includes("on shift") ||
    s.includes("logged in") ||
    s.includes("loggedon") ||
    s.includes("signed on") ||
    evt.includes("shiftstart") ||
    sub === "started"
  ) return true;

  if (
    s.includes("end") ||
    s.includes("off shift") ||
    s.includes("logged out") ||
    s.includes("loggedoff") ||
    s.includes("signed off") ||
    (s.includes("off") && !s.includes("offline status ignored")) ||
    evt.includes("shiftend") ||
    sub === "ended"
  ) return false;

  return null;
}

// ---------- SSE ----------
let sseClients = new Set();

app.get("/api/status/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const snapshot = Array.from(onlineMap.entries()).map(([k, v]) => statusPayload(k, v));
  res.write(`event: snapshot\ndata:${JSON.stringify({ data: snapshot })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

const HEARTBEAT_MS = 25000;
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(`:heartbeat ${Date.now()}\n\n`); } catch {}
  }
}, HEARTBEAT_MS);

function broadcastStatus(callsign, rec) {
  const payload = statusPayload(callsign, rec);
  const msg = `event: status\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

/**
 * Timeout sweeper: broadcasts transitions caused by time passing
 */
const TIMEOUT_SWEEP_MS = Number(process.env.TIMEOUT_SWEEP_MS || 30000);
let lastOnlineState = new Map(); // callsign -> boolean

setInterval(() => {
  for (const [cs, rec] of onlineMap.entries()) {
    const nowOnline = computeOnline(rec);
    const prevOnline = lastOnlineState.get(cs);

    if (prevOnline === undefined) {
      lastOnlineState.set(cs, nowOnline);
      continue;
    }

    if (prevOnline !== nowOnline) {
      lastOnlineState.set(cs, nowOnline);
      broadcastStatus(cs, rec);
    }
  }
}, TIMEOUT_SWEEP_MS);

// ---------- Webhook diagnostics ----------
// Autocab may test the provider base URL before sending event payloads.
// These routes return a fast 200 response and show the accepted event URLs.
function webhookReadyPayload(req) {
  const origin = `${req.protocol}://${req.get("host")}`;
  return {
    ok: true,
    service: "Hackney Status Webhooks",
    accepted: {
      status: [`${origin}/status`, `${origin}/webhook/status`],
      location: [`${origin}/location`, `${origin}/webhook/location`],
      shiftChange: [`${origin}/ShiftChange`, `${origin}/webhook/ShiftChange`],
    },
    timestamp: new Date().toISOString(),
  };
}

app.get("/webhook", (req, res) => res.status(200).json(webhookReadyPayload(req)));
app.post("/webhook", (req, res) => res.status(200).json(webhookReadyPayload(req)));
app.get("/webhooks", (req, res) => res.status(200).json(webhookReadyPayload(req)));
app.post("/webhooks", (req, res) => res.status(200).json(webhookReadyPayload(req)));

// ---------- Webhook auth ----------
function checkWebhookAuth(req, res) {
  if (!WEBHOOK_TOKEN) return true;
  const provided = req.headers["x-webhook-token"];
  if (provided !== WEBHOOK_TOKEN) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------- HackneyLocation: simple ping (now can mark online) ----------
app.post([
  "/location",
  "/Location",
  "/hackneylocation",
  "/HackneyLocation",
  "/webhook/location",
  "/webhook/Location",
  "/webhook/hackneylocation",
  "/webhook/HackneyLocation",
], (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    lastHackneyLocationPayload = req.body;
    debugLog("WEBHOOK HIT: HackneyLocation", req.body);

    const items = coercePayloadToArray(req.body);
    let updates = 0;
    const nowIso = new Date().toISOString();

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const cs = extractCallsignGeneric(item);
      if (!cs) continue;
      const key = normKey(cs);

      const ts = item.Timestamp || item.timestamp || item.time || nowIso;

      const existing = onlineMap.get(key) || {};

      // Only update if newer
      if (!isNewerTimestamp(ts, existing.updatedAt || existing.lastPingAt || null)) continue;

      // If explicitly OFF, keep OFF. Else treat ping as online.
      let explicitOnline = existing.explicitOnline;
      if (explicitOnline === undefined || explicitOnline === null) explicitOnline = true;

      const rec = {
        ...existing,
        lastPingAt: ts,
        updatedAt: ts,
        explicitOnline,
      };

      onlineMap.set(key, rec);
      lastOnlineState.set(key, computeOnline(rec));
      updates++;
      broadcastStatus(key, rec);
    }

    if (updates > 0) saveStatusToDisk();
    res.json({ ok: true, updates });
  } catch (e) {
    console.error("HackneyLocation error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- Status: VehicleTracksChanged ----------
app.post([
  "/status",
  "/Status",
  "/webhook/status",
  "/webhook/Status",
], (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    lastStatusPayload = req.body;
    debugLog("WEBHOOK HIT: Status / VehicleTracks", req.body);

    const body = req.body || {};
    const tracks = Array.isArray(body.VehicleTracks) ? body.VehicleTracks : coercePayloadToArray(body);

    let updates = 0;

    for (const track of tracks) {
      if (!track || typeof track !== "object") continue;

      const vehicle = track.Vehicle || {};
      const driver  = track.Driver  || {};

      const cs =
        vehicle.Callsign ||
        driver.Callsign ||
        extractCallsignGeneric(track) ||
        null;
      if (!cs) continue;

      const key = normKey(cs);
      const ts  = track.Timestamp || track.timestamp || track.time || new Date().toISOString();

      const rawCode = track.VehicleStatus || track.vehicleStatus || null;
      const label   = vehicleStatusLabel(rawCode);

      const existing = onlineMap.get(key) || {};

      // Only update if newer
      if (!isNewerTimestamp(ts, existing.updatedAt || null)) continue;

      const rec = {
        ...existing,
        lastPingAt: ts,            // IMPORTANT: status update counts as heartbeat
        updatedAt: ts,
        driverStatusCode: rawCode || existing.driverStatusCode || null,
        driverStatusLabel: label ?? existing.driverStatusLabel ?? rawCode ?? null,
        explicitOnline: true,      // tracking → definitely on/working
      };
      rec.driverStatus = rec.driverStatusLabel;

      onlineMap.set(key, rec);
      lastOnlineState.set(key, computeOnline(rec));
      updates++;
      broadcastStatus(key, rec);
    }

    if (updates > 0) {
      console.log(`Status webhook: updated ${updates} tracks`);
      saveStatusToDisk();
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("Status webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- ShiftChange: logon/logoff ----------
app.post([
  "/shiftchange",
  "/ShiftChange",
  "/webhook/shiftchange",
  "/webhook/ShiftChange",
], (req, res) => {
  try {
    if (!checkWebhookAuth(req, res)) return;

    lastShiftChangePayload = req.body;
    debugLog("WEBHOOK HIT: ShiftChange", req.body);

    const items = coercePayloadToArray(req.body);
    let updates = 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const vehicle = item.Vehicle || {};
      const driver  = item.Driver  || {};

      const cs =
        vehicle.Callsign ||
        driver.Callsign ||
        extractCallsignGeneric(item) ||
        null;
      if (!cs) continue;

      const key = normKey(cs);

      const ts =
        item.Timestamp ||
        item.timestamp ||
        item.ModifiedDate ||
        item.EventTime ||
        new Date().toISOString();

      const rawStatus =
        item.ShiftStatus ??
        item.shiftStatus ??
        item.Status ??
        item.status ??
        item.DriverStatus ??
        item.driverStatus ??
        null;

      const eventType = item.EventType || item.Event || null;
      const subType   = item.SubEventType || item.subEventType || null;

      const label = shiftStatusLabel(rawStatus, eventType, subType, item);
      let explicit = inferExplicitOnlineFromShift(rawStatus, eventType, subType, item);

      if (explicit === null && label) {
        const l = label.toLowerCase();
        if (l.includes("off shift") || l.includes("off duty") || l.includes("logged off") || l.includes("signed off")) {
          explicit = false;
        } else if (l.includes("on shift") || l.includes("on duty") || l.includes("logged on") || l.includes("logged in") || l.includes("signed on")) {
          explicit = true;
        }
      }

      const existing = onlineMap.get(key) || {};

      // Only update if newer
      if (!isNewerTimestamp(ts, existing.updatedAt || null)) continue;

      let rec = {
        ...existing,
        updatedAt: ts,
        lastPingAt: existing.lastPingAt || null,
        driverStatusLabel: label ?? existing.driverStatusLabel ?? existing.driverStatus ?? null,
        driverStatusCode: existing.driverStatusCode ?? null,
        explicitOnline: existing.explicitOnline ?? null,
      };
      rec.driverStatus = rec.driverStatusLabel;

      if (explicit === true) {
        rec.explicitOnline = true;
        rec.lastPingAt = ts;
      } else if (explicit === false) {
        rec.explicitOnline = false;
        rec.lastPingAt = null;
      }

      onlineMap.set(key, rec);
      lastOnlineState.set(key, computeOnline(rec));
      updates++;
      broadcastStatus(key, rec);

      console.log(
        `ShiftChange: callsign=${key} ts=${ts} rawStatus=${rawStatus} eventType=${eventType} subType=${subType} explicitOnline=${rec.explicitOnline} driverStatus=${rec.driverStatusLabel}`
      );
    }

    if (updates > 0) {
      console.log(`ShiftChange webhook: updated ${updates} vehicles`);
      saveStatusToDisk();
    }

    res.json({ ok: true, updates });
  } catch (e) {
    console.error("ShiftChange webhook error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- DEBUG INSPECTION ENDPOINTS ----------
app.get("/debug/last-hackney", (_req, res) => {
  res.json({
    received: !!lastHackneyLocationPayload,
    timestamp: new Date().toISOString(),
    payload: lastHackneyLocationPayload,
  });
});

app.get("/debug/last-status", (_req, res) => {
  res.json({
    received: !!lastStatusPayload,
    timestamp: new Date().toISOString(),
    payload: lastStatusPayload,
  });
});

app.get("/debug/last-shiftchange", (_req, res) => {
  res.json({
    received: !!lastShiftChangePayload,
    timestamp: new Date().toISOString(),
    payload: lastShiftChangePayload,
  });
});

// ---------- Public API ----------
app.get("/api/status", (_req, res) => {
  const arr = Array.from(onlineMap.entries()).map(([k, v]) => statusPayload(k, v));
  res.json({ data: arr, count: arr.length, ts: new Date().toISOString() });
});

function getVehicleId(vehicle) {
  return vehicle?.id ?? vehicle?.vehicleId ?? vehicle?.vehicleID ?? null;
}

async function fetchVehiclePermitExpiry(vehicle) {
  // Reuse a populated list value, but a null list value still triggers the
  // requested single-vehicle endpoint because that endpoint is authoritative.
  if (vehicle?.motExpiryDate) {
    return vehicle.motExpiryDate;
  }

  const vehicleId = getVehicleId(vehicle);
  if (vehicleId === null || vehicleId === undefined || vehicleId === "") return null;

  const cacheKey = String(vehicleId);
  const cached = permitDetailCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.motExpiryDate;

  const url = `https://autocab-api.azure-api.net/vehicle/v1/vehicles/${encodeURIComponent(cacheKey)}`;
  try {
    const response = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": AUTOCAB_KEY,
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`Permit detail lookup failed for vehicle ${cacheKey}:`, response.status, text.slice(0, 250));
      permitDetailCache.set(cacheKey, { expiresAt: Date.now() + 60_000, motExpiryDate: null });
      return null;
    }

    const detail = await response.json();
    const motExpiryDate = detail?.motExpiryDate ?? detail?.vehicle?.motExpiryDate ?? detail?.data?.motExpiryDate ?? null;
    permitDetailCache.set(cacheKey, {
      expiresAt: Date.now() + PERMIT_CACHE_TTL_MS,
      motExpiryDate,
    });
    return motExpiryDate;
  } catch (error) {
    console.warn(`Permit detail lookup error for vehicle ${cacheKey}:`, error.message);
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => worker()
  );
  await Promise.all(workers);
  return output;
}

// Proxy vehicles from Autocab and enrich each record with the permit expiry date.
app.get("/api/vehicles", async (_req, res) => {
  try {
    if (!AUTOCAB_KEY) {
      return res.status(500).json({ error: "Missing AUTOCAB_KEY in .env" });
    }

    const url = "https://autocab-api.azure-api.net/vehicle/v1/vehicles";
    const r = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": AUTOCAB_KEY,
        "Cache-Control": "no-cache",
      },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("Upstream /vehicles error:", r.status, txt);
      return res.status(r.status).send(txt || `Upstream error: ${r.statusText}`);
    }

    const data = await r.json();

    const list =
      Array.isArray(data) ? data :
      Array.isArray(data?.items) ? data.items :
      Array.isArray(data?.results) ? data.results :
      Array.isArray(data?.vehicles) ? data.vehicles :
      Array.isArray(data?.data) ? data.data :
      null;

    if (Array.isArray(list)) {
      const normalized = await mapWithConcurrency(
        list,
        PERMIT_DETAIL_CONCURRENCY,
        async (v) => ({
          ...v,
          isSuspended: v?.isSuspended === true,
          // UI name is "Permit expiry date"; Autocab source field is motExpiryDate.
          permitExpiryDate: await fetchVehiclePermitExpiry(v),
        })
      );

      if (Array.isArray(data)) return res.json(normalized);

      if (Array.isArray(data?.items))    return res.json({ ...data, items: normalized });
      if (Array.isArray(data?.results))  return res.json({ ...data, results: normalized });
      if (Array.isArray(data?.vehicles)) return res.json({ ...data, vehicles: normalized });
      if (Array.isArray(data?.data))     return res.json({ ...data, data: normalized });

      return res.json({ ...data, items: normalized });
    }

    res.json(data);
  } catch (e) {
    console.error("/api/vehicles error:", e);
    res.status(500).json({ error: e.message });
  }
});


// ---------- Secure permit administration ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const AUDIT_FILE = path.resolve(process.env.PERMIT_AUDIT_FILE || "./permit-audit.jsonl");
const GWR_PERMIT_FILE = path.resolve(process.env.GWR_PERMIT_FILE || "./gwr-permits.json");
const GWR_PHOTO_DIR = path.resolve(process.env.GWR_PHOTO_DIR || "./permit-photos");
fs.mkdirSync(GWR_PHOTO_DIR,{recursive:true});
function readGwrPermits(){try{return fs.existsSync(GWR_PERMIT_FILE)?JSON.parse(fs.readFileSync(GWR_PERMIT_FILE,"utf8")):{};}catch{return {};}}
function writeGwrPermits(data){fs.writeFileSync(GWR_PERMIT_FILE,JSON.stringify(data,null,2),"utf8");}
const photoUpload=multer({storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,GWR_PHOTO_DIR),filename:(req,file,cb)=>{const ext=(path.extname(file.originalname)||".jpg").toLowerCase();cb(null,`vehicle-${req.params.vehicleId}-${Date.now()}${ext}`)}}),limits:{fileSize:5*1024*1024},fileFilter:(_r,file,cb)=>cb(null,/^image\/(jpeg|png|webp)$/.test(file.mimetype))});

const authSessions = new Map();

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf("="); return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}
function createAdminSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  authSessions.set(token, { csrf, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  return { token, csrf };
}
function getAdminSession(req) {
  const token = parseCookies(req).permit_admin;
  const session = token ? authSessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) { if (token) authSessions.delete(token); return null; }
  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  return { token, ...session };
}
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Set ADMIN_PASSWORD in .env before using the permit administration page." });
  const session = getAdminSession(req);
  if (!session) {
    if (req.accepts("html") && !req.path.startsWith("/api/")) return res.redirect("/permit-login");
    return res.status(401).json({ error: "Sign in required." });
  }
  req.adminSession = session;
  next();
}
function requireCsrf(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const supplied = String(req.headers["x-csrf-token"] || "");
  if (!req.adminSession || !supplied || supplied !== req.adminSession.csrf) return res.status(403).json({ error: "Security token is missing or expired. Refresh and sign in again." });
  next();
}
app.get("/permit-login", (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-login.html")));
app.post("/api/permit-login", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Set ADMIN_PASSWORD in .env first." });
  const supplied = String(req.body?.password || "");
  const a = Buffer.from(supplied); const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Incorrect password." });
  const { token, csrf } = createAdminSession();
  res.setHeader("Set-Cookie", `permit_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS/1000)}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  res.json({ ok: true, csrf });
});
app.post("/api/permit-logout", requireAdmin, (req, res) => { authSessions.delete(req.adminSession.token); res.setHeader("Set-Cookie", "permit_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.get("/api/permit-auth", requireAdmin, (req, res) => res.json({ ok: true, csrf: req.adminSession.csrf }));
app.get("/permit-updater", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-updater.html")));
app.get("/permit-updater.html", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-updater.html")));

// ---------- Permit spreadsheet importer ----------
const permitUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    if ([".xlsx", ".xls", ".csv"].some(ext => name.endsWith(ext))) return cb(null, true);
    cb(new Error("Please upload an Excel (.xlsx/.xls) or CSV file."));
  },
});
const importSessions = new Map();
const IMPORT_SESSION_TTL_MS = 60 * 60 * 1000;
const BULK_UPDATE_CONCURRENCY = Math.max(1, Number(process.env.BULK_UPDATE_CONCURRENCY || 2));
function cleanupImportSessions() { const now = Date.now(); for (const [id,s] of importSessions) if (s.expiresAt <= now) importSessions.delete(id); }
setInterval(cleanupImportSessions, 5*60*1000).unref();
function normalizeVehicleText(value) { return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function normalizeHeader(value) { return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); }
function pickColumn(headers, aliases) { const normal=headers.map(normalizeHeader); for (const alias of aliases) { const i=normal.indexOf(normalizeHeader(alias)); if(i>=0)return headers[i]; } return null; }
function excelSerialToDate(value) { const p=XLSX.SSF.parse_date_code(value); return p ? new Date(Date.UTC(p.y,p.m-1,p.d)) : null; }
function parsePermitDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(Date.UTC(value.getFullYear(),value.getMonth(),value.getDate()));
  if (typeof value === "number" && Number.isFinite(value)) return excelSerialToDate(value);
  const raw=String(value).trim(); let m=raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(m){const d=+m[1],mo=+m[2],y=+m[3],dt=new Date(Date.UTC(y,mo-1,d)); return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?dt:null;}
  m=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
  if(m){const y=+m[1],mo=+m[2],d=+m[3],dt=new Date(Date.UTC(y,mo-1,d)); return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?dt:null;}
  return null;
}
function dateKey(value){const d=parsePermitDate(value); return d?d.toISOString().slice(0,10):null;}
function toAutocabDate(date) { return date ? `${date.toISOString().slice(0,10)}T00:00:00` : null; }
function displayDate(value) { const d=parsePermitDate(value); return d ? new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(d) : "—"; }
function daysFromToday(date){const today=new Date(); const utc=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()); return Math.round((date.getTime()-utc)/86400000);}
async function autocabRequest(url, options={}) {
  if(!AUTOCAB_KEY) throw new Error("Missing AUTOCAB_KEY in .env");
  const response=await fetch(url,{...options,headers:{"Cache-Control":"no-cache","Ocp-Apim-Subscription-Key":AUTOCAB_KEY,...(options.body?{"Content-Type":"application/json"}:{}),...(options.headers||{})}});
  const text=await response.text(); let data=null; if(text){try{data=JSON.parse(text)}catch{data=text}}
  if(!response.ok){const e=new Error(typeof data==="string"?data:data?.message||`Autocab returned ${response.status}`);e.status=response.status;e.details=data;throw e;} return data;
}
function extractVehicleList(data){if(Array.isArray(data))return data;for(const k of["items","results","vehicles","data"])if(Array.isArray(data?.[k]))return data[k];return[];}
const H_CAPABILITY_IDS = String(process.env.H_CAPABILITY_IDS || "14").split(",").map(x=>x.trim()).filter(Boolean);
function hasHCapability(v){
  const values=[];
  const push=x=>{if(x!==undefined&&x!==null)values.push(x)};
  (v?.capabilityIds||[]).forEach(push); (v?.capabilities||[]).forEach(push); push(v?.capability);
  return values.some(c=>{
    if(typeof c==="number") return H_CAPABILITY_IDS.includes(String(c));
    if(typeof c==="string"){const x=c.trim();return x.toUpperCase()==="H"||x.toLowerCase().includes("hackney")||H_CAPABILITY_IDS.includes(x)}
    if(c&&typeof c==="object"){const bits=[c.id,c.capabilityId,c.code,c.name,c.description].filter(x=>x!==undefined&&x!==null).map(String);return bits.some(x=>x.toUpperCase()==="H"||x.toLowerCase().includes("hackney")||H_CAPABILITY_IDS.includes(x))}
    return false;
  });
}
function isHackney(v){return v?.isActive!==false&&hasHCapability(v);}
function appendAudit(entry){fs.mkdirSync(path.dirname(AUDIT_FILE),{recursive:true});fs.appendFileSync(AUDIT_FILE,JSON.stringify(entry)+"\n","utf8");}
function buildWorkbook(rows, sheetName, columns){const wb=XLSX.utils.book_new();const data=[columns.map(c=>c.label),...rows.map(r=>columns.map(c=>typeof c.value==="function"?c.value(r):r[c.value]))];const ws=XLSX.utils.aoa_to_sheet(data);ws["!cols"]=columns.map(c=>({wch:c.width||18}));ws["!autofilter"]={ref:`A1:${XLSX.utils.encode_col(columns.length-1)}${Math.max(1,data.length)}`};XLSX.utils.book_append_sheet(wb,ws,sheetName);return XLSX.write(wb,{type:"buffer",bookType:"xlsx"});}
function sendXlsx(res, buffer, filename){res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(buffer);}

app.get("/api/permit-template", requireAdmin, (req,res)=>{
  const buffer=buildWorkbook([{registration:"AB12 CDE",plate:"0123",expiry:"31/12/2027"}],"Permit Updates",[
    {label:"Registration Number",value:"registration",width:24},{label:"Plate Number",value:"plate",width:18},{label:"Permit Expiry Date",value:"expiry",width:22}
  ]); sendXlsx(res,buffer,"permit-update-template.xlsx");
});

app.get("/api/permit-current-export", requireAdmin, async(req,res)=>{
  try{
    const list=extractVehicleList(await autocabRequest("https://autocab-api.azure-api.net/vehicle/v1/vehicles")).filter(isHackney);
    const rows=await mapWithConcurrency(list,PERMIT_DETAIL_CONCURRENCY,async v=>{try{const d=await autocabRequest(`https://autocab-api.azure-api.net/vehicle/v1/vehicles/${encodeURIComponent(v.id)}`);const expiry=d.motExpiryDate;const days=expiry?daysFromToday(parsePermitDate(expiry)):null;return{callsign:d.callsign,id:d.id,registration:d.registration,plate:d.plateNumber,expiry:displayDate(expiry),iso:dateKey(expiry)||"",status:!expiry?"No permit date":days<0?"Expired":days<=30?"Expiring within 30 days":"Valid",days:days??""};}catch(e){return{callsign:v.callsign,id:v.id,registration:v.registration,plate:v.plateNumber,expiry:"",iso:"",status:`Error: ${e.message}`,days:""};}});
    rows.sort((a,b)=>Number(a.callsign)-Number(b.callsign));
    sendXlsx(res,buildWorkbook(rows,"Current Permit Status",[
      {label:"Callsign",value:"callsign",width:12},{label:"Vehicle ID",value:"id",width:12},{label:"Registration Number",value:"registration",width:22},{label:"Plate Number",value:"plate",width:18},{label:"Permit Expiry Date",value:"expiry",width:24},{label:"ISO Date",value:"iso",width:14},{label:"Permit Status",value:"status",width:26},{label:"Days Until Expiry",value:"days",width:18}
    ]),`hackney-permit-status-${new Date().toISOString().slice(0,10)}.xlsx`);
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

app.post("/api/permit-import", requireAdmin, requireCsrf, permitUpload.single("file"), async(req,res)=>{
 try{
  if(!req.file)return res.status(400).json({error:"Choose a spreadsheet first."});
  const workbook=XLSX.read(req.file.buffer,{type:"buffer",cellDates:true});const sheetName=workbook.SheetNames[0];if(!sheetName)return res.status(400).json({error:"The workbook has no worksheets."});
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{defval:"",raw:true});if(!rows.length)return res.status(400).json({error:"The first worksheet contains no data rows."});
  const headers=Object.keys(rows[0]);const regColumn=pickColumn(headers,["Registration Number","Registration","Reg Number","Reg","Vehicle Registration"]);const plateColumn=pickColumn(headers,["Plate Number","Plate","Taxi Plate","Licence Plate Number","License Plate Number"]);const expiryColumn=pickColumn(headers,["Permit Expiry Date","Permit Expiry","Expiry Date","MOT Expiry Date","MOT Expiry"]);
  if(!regColumn||!plateColumn||!expiryColumn)return res.status(400).json({error:"Required columns were not found.",requiredColumns:["Registration Number","Plate Number","Permit Expiry Date"],detectedColumns:headers});
  const vehicles=extractVehicleList(await autocabRequest("https://autocab-api.azure-api.net/vehicle/v1/vehicles"));const exact=new Map(),byReg=new Map(),byPlate=new Map();
  for(const v of vehicles){const r=normalizeVehicleText(v.registration),p=normalizeVehicleText(v.plateNumber),k=`${r}|${p}`;for(const [map,key] of [[exact,k],[byReg,r],[byPlate,p]]){if(!map.has(key))map.set(key,[]);map.get(key).push(v);}}
  const seen=new Set(),previews=[];
  for(let i=0;i<rows.length;i++){
   const source=rows[i],registration=String(source[regColumn]??"").trim(),plateNumber=String(source[plateColumn]??"").trim(),permitDate=parsePermitDate(source[expiryColumn]);const regNorm=normalizeVehicleText(registration),plateNorm=normalizeVehicleText(plateNumber),key=`${regNorm}|${plateNorm}`;
   let status="ready",group="ready",message="Registration and plate both match.",vehicle=null,detail=null,warnings=[];
   if(!registration||!plateNumber){status="invalid";group="error";message="Registration and plate number are required.";}
   else if(!permitDate){status="invalid";group="error";message="Permit expiry date is invalid. Use DD/MM/YYYY or YYYY-MM-DD.";}
   else if(seen.has(key)){status="duplicate";group="review";message="Duplicate registration and plate in this spreadsheet.";}
   else{seen.add(key);const matches=exact.get(key)||[];if(matches.length===1)vehicle=matches[0];else if(matches.length>1){status="ambiguous";group="review";message="More than one Autocab vehicle matches both values.";}else{const regMatches=byReg.get(regNorm)||[],plateMatches=byPlate.get(plateNorm)||[];status="not_found";group="review";message=regMatches.length?`Registration matches Autocab, but plate does not. Autocab plate: ${regMatches[0].plateNumber||"blank"}.`:plateMatches.length?`Plate matches Autocab, but registration does not. Autocab registration: ${plateMatches[0].registration||"blank"}.`:"No Autocab vehicle matches the registration or plate.";}}
   if(vehicle&&status==="ready"){try{detail=await autocabRequest(`https://autocab-api.azure-api.net/vehicle/v1/vehicles/${encodeURIComponent(vehicle.id)}`);if(normalizeVehicleText(detail.registration)!==regNorm||normalizeVehicleText(detail.plateNumber)!==plateNorm){status="mismatch";group="review";message="The detailed Autocab record no longer matches both uploaded values.";}else if(dateKey(detail.motExpiryDate)===dateKey(permitDate)){status="already_current";group="current";message="Autocab already has this permit expiry date. No update required.";}else{const days=daysFromToday(permitDate);if(days<0){status="ready_past";group="ready";warnings.push("The new permit expiry date is in the past.");message="Match confirmed, but the new date is already expired.";}else if(days>366*5){status="ready_future";group="ready";warnings.push("The new permit date is more than five years away.");message="Match confirmed, but the new date is unusually far in the future.";}}}catch(e){status="error";group="error";message=`Could not load vehicle details: ${e.message}`;}}
   previews.push({rowNumber:i+2,registration,plateNumber,permitExpiryDate:permitDate?dateKey(permitDate):null,permitExpiryDisplay:permitDate?displayDate(permitDate):"—",status,group,message,warnings,vehicleId:detail?.id??vehicle?.id??null,callsign:detail?.callsign??vehicle?.callsign??"",currentPermitExpiryDate:detail?.motExpiryDate??null,currentPermitExpiryDisplay:displayDate(detail?.motExpiryDate)});
  }
  const sessionId=crypto.randomUUID();importSessions.set(sessionId,{expiresAt:Date.now()+IMPORT_SESSION_TTL_MS,filename:req.file.originalname,sheetName,rows:previews,results:[]});
  const summary=previews.reduce((a,r)=>{a[r.group]=(a[r.group]||0)+1;return a;},{});res.json({sessionId,sheetName,filename:req.file.originalname,totalRows:previews.length,summary,rows:previews});
 }catch(e){console.error("Permit import failed:",e);res.status(e.status||500).json({error:e.message||"Import failed."});}
});

function reviewColumns(){return[
 {label:"Spreadsheet Row",value:"rowNumber",width:16},{label:"Callsign",value:"callsign",width:12},{label:"Vehicle ID",value:"vehicleId",width:12},{label:"Registration Number",value:"registration",width:22},{label:"Plate Number",value:"plateNumber",width:18},{label:"Current Permit Expiry",value:"currentPermitExpiryDisplay",width:24},{label:"Requested Permit Expiry",value:"permitExpiryDisplay",width:24},{label:"Review Status",value:"status",width:20},{label:"Review Message",value:"message",width:55}
];}
app.get("/api/permit-review-report/:sessionId", requireAdmin, (req,res)=>{const s=importSessions.get(req.params.sessionId);if(!s)return res.status(410).json({error:"Review session expired."});sendXlsx(res,buildWorkbook(s.rows,"Review Report",reviewColumns()),`permit-review-${new Date().toISOString().slice(0,10)}.xlsx`);});
app.get("/api/permit-update-report/:sessionId", requireAdmin, (req,res)=>{const s=importSessions.get(req.params.sessionId);if(!s)return res.status(410).json({error:"Review session expired."});const rows=s.results||[];sendXlsx(res,buildWorkbook(rows,"Update Report",[
 {label:"Spreadsheet Row",value:"rowNumber",width:16},{label:"Callsign",value:"callsign",width:12},{label:"Vehicle ID",value:"vehicleId",width:12},{label:"Registration",value:"registration",width:20},{label:"Plate",value:"plateNumber",width:16},{label:"Previous Expiry",value:"previousDisplay",width:22},{label:"Requested Expiry",value:"requestedDisplay",width:22},{label:"Verified Expiry",value:"verifiedDisplay",width:22},{label:"Result",value:"status",width:16},{label:"Message",value:"message",width:55},{label:"Updated At",value:"timestamp",width:24}
]),`permit-update-results-${new Date().toISOString().slice(0,10)}.xlsx`);});
app.get("/api/permit-audit-export", requireAdmin, (_req,res)=>{let rows=[];try{rows=fs.existsSync(AUDIT_FILE)?fs.readFileSync(AUDIT_FILE,"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x)):[]}catch{};sendXlsx(res,buildWorkbook(rows,"Permit Audit",[
 {label:"Timestamp",value:"timestamp",width:24},{label:"Source File",value:"sourceFile",width:28},{label:"Row",value:"rowNumber",width:10},{label:"Callsign",value:"callsign",width:12},{label:"Vehicle ID",value:"vehicleId",width:12},{label:"Registration",value:"registration",width:20},{label:"Plate",value:"plateNumber",width:16},{label:"Previous Expiry",value:"previousExpiry",width:22},{label:"New Expiry",value:"newExpiry",width:22},{label:"Verified Expiry",value:"verifiedExpiry",width:22},{label:"Result",value:"status",width:16},{label:"Message",value:"message",width:55}
]),`permit-audit-${new Date().toISOString().slice(0,10)}.xlsx`);});

app.post("/api/permit-update-stream", requireAdmin, requireCsrf, async(req,res)=>{
 cleanupImportSessions();const {sessionId,rowNumbers}=req.body||{},session=importSessions.get(String(sessionId||""));if(!session)return res.status(410).json({error:"This preview has expired. Upload the spreadsheet again."});
 const selected=new Set((Array.isArray(rowNumbers)?rowNumbers:[]).map(Number));const candidates=session.rows.filter(r=>["ready","ready_past","ready_future"].includes(r.status)&&selected.has(r.rowNumber));if(!candidates.length)return res.status(400).json({error:"There are no valid selected rows to update."});
 res.status(200);res.setHeader("Content-Type","application/x-ndjson; charset=utf-8");res.setHeader("Cache-Control","no-cache");res.setHeader("X-Content-Type-Options","nosniff");res.flushHeaders?.();
 const send=obj=>res.write(JSON.stringify(obj)+"\n");send({type:"start",total:candidates.length});session.results=[];
 let done=0,updated=0,failed=0;
 for(const row of candidates){let result;try{
   const url=`https://autocab-api.azure-api.net/vehicle/v1/vehicles/${encodeURIComponent(row.vehicleId)}`,current=await autocabRequest(url);
   if(normalizeVehicleText(current.registration)!==normalizeVehicleText(row.registration)||normalizeVehicleText(current.plateNumber)!==normalizeVehicleText(row.plateNumber))throw new Error("Safety check failed: registration or plate no longer matches.");
   const previous=dateKey(current.motExpiryDate),requested=dateKey(row.permitExpiryDate);
   if(previous===requested){result={status:"already_current",message:"No write required; Autocab already contains this date.",previousExpiry:previous,verifiedExpiry:previous};}
   else{const updatedVehicle={...current,motExpiryDate:toAutocabDate(parsePermitDate(row.permitExpiryDate))};await autocabRequest(url,{method:"PUT",body:JSON.stringify(updatedVehicle)});permitDetailCache.delete(String(row.vehicleId));const verify=await autocabRequest(url),verified=dateKey(verify.motExpiryDate);if(verified!==requested)throw new Error(`Verification failed. Autocab returned ${verified||"no date"}.`);result={status:"updated",message:"Updated and verified in Autocab.",previousExpiry:previous,verifiedExpiry:verified};}
   updated++;
  }catch(e){failed++;result={status:"failed",message:e.message,previousExpiry:null,verifiedExpiry:null};}
  done++;const full={rowNumber:row.rowNumber,vehicleId:row.vehicleId,callsign:row.callsign,registration:row.registration,plateNumber:row.plateNumber,requestedExpiry:row.permitExpiryDate,requestedDisplay:displayDate(row.permitExpiryDate),previousExpiry:result.previousExpiry,previousDisplay:displayDate(result.previousExpiry),verifiedExpiry:result.verifiedExpiry,verifiedDisplay:displayDate(result.verifiedExpiry),status:result.status,message:result.message,timestamp:new Date().toISOString()};session.results.push(full);appendAudit({...full,sourceFile:session.filename,newExpiry:row.permitExpiryDate});send({type:"progress",done,total:candidates.length,result:full});
 }
 send({type:"complete",total:candidates.length,updated,failed});res.end();
});


// ---------- All-in-one permit manager dashboard ----------
function permitStatus(expiryValue) {
  const parsed = parsePermitDate(expiryValue);
  if (!parsed) return { key: "missing", label: "No permit", days: null };
  const days = daysFromToday(parsed);
  if (days < 0) return { key: "expired", label: "Expired", days };
  if (days <= 30) return { key: "expiring", label: "Expires within 30 days", days };
  return { key: "valid", label: "Valid", days };
}

async function loadHackneyPermitDashboard() {
  const list = extractVehicleList(await autocabRequest("https://autocab-api.azure-api.net/vehicle/v1/vehicles"))
    .filter(isHackney);
  const permits = await mapWithConcurrency(list, PERMIT_DETAIL_CONCURRENCY, async (vehicle) => {
    try {
      const detail = await autocabRequest(`https://autocab-api.azure-api.net/vehicle/v1/vehicles/${encodeURIComponent(vehicle.id)}`);
      const status = permitStatus(detail.motExpiryDate);
      return {
        vehicleId: detail.id,
        rowVersion: detail.rowVersion,
        callsign: String(detail.callsign ?? ""),
        registration: String(detail.registration ?? ""),
        plateNumber: String(detail.plateNumber ?? ""),
        permitExpiryDate: dateKey(detail.motExpiryDate),
        permitExpiryDisplay: displayDate(detail.motExpiryDate),
        status: status.key,
        statusLabel: status.label,
        daysUntilExpiry: status.days,
        isSuspended: detail.isSuspended === true,
        isActive: detail.isActive !== false,
        gwrPermit: readGwrPermits()[String(detail.id)] || null,
      };
    } catch (error) {
      return {
        vehicleId: vehicle.id,
        callsign: String(vehicle.callsign ?? ""),
        registration: String(vehicle.registration ?? ""),
        plateNumber: String(vehicle.plateNumber ?? ""),
        permitExpiryDate: null,
        permitExpiryDisplay: "—",
        status: "error",
        statusLabel: "Could not load",
        daysUntilExpiry: null,
        error: error.message,
      };
    }
  });
  permits.sort((a, b) => Number(a.callsign) - Number(b.callsign));
  const summary = permits.reduce((result, item) => {
    result.total += 1;
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, { total: 0, valid: 0, expiring: 0, expired: 0, missing: 0, error: 0 });
  return { permits, summary, generatedAt: new Date().toISOString() };
}

app.get("/dashboard", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-manager.html")));
app.get("/permit-manager", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-manager.html")));
app.get("/permit-manager.html", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-manager.html")));
app.get("/permits", (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-mobile.html")));
app.get("/permit-mobile", (_req, res) => res.sendFile(path.join(__dirname, "public", "permit-mobile.html")));

app.get("/api/permit-dashboard", requireAdmin, async (_req, res) => {
  try { res.json(await loadHackneyPermitDashboard()); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.get("/api/permit-public-search", async (req, res) => {
  try {
    const query = normalizeVehicleText(req.query.q || "");
    const dashboard = await loadHackneyPermitDashboard();
    const rows = dashboard.permits
      .filter(item => !query || normalizeVehicleText(item.registration).includes(query))
      .slice(0, query ? 25 : 100)
      .map(({ vehicleId, callsign, registration, plateNumber, permitExpiryDate, permitExpiryDisplay, status, statusLabel, daysUntilExpiry }) => ({
        vehicleId, callsign, registration, plateNumber, permitExpiryDate, permitExpiryDisplay, status, statusLabel, daysUntilExpiry
      }));
    res.json({ permits: rows, count: rows.length, generatedAt: dashboard.generatedAt });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

async function saveManualPermit({ vehicleId, registration, plateNumber, permitExpiryDate, action, allowOverwrite }) {
  const parsedDate = parsePermitDate(permitExpiryDate);
  if (!parsedDate) throw Object.assign(new Error("Enter a valid permit expiry date."), { status: 400 });
  const url = `https://autocab-api.azure-api.net/vehicle/v1/vehicles/${encodeURIComponent(vehicleId)}`;
  const current = await autocabRequest(url);
  if (normalizeVehicleText(current.registration) !== normalizeVehicleText(registration) ||
      normalizeVehicleText(current.plateNumber) !== normalizeVehicleText(plateNumber)) {
    throw Object.assign(new Error("Safety check failed: the registration or plate number no longer matches Autocab."), { status: 409 });
  }
  const previous = dateKey(current.motExpiryDate);
  const requested = dateKey(parsedDate);
  if (action === "create" && previous && !allowOverwrite) {
    throw Object.assign(new Error("This vehicle already has a permit date. Use Update permit instead."), { status: 409 });
  }
  if (previous === requested) {
    return { status: "already_current", message: "Autocab already contains this permit expiry date.", previousExpiry: previous, verifiedExpiry: previous, vehicle: current };
  }
  const updated = { ...current, motExpiryDate: toAutocabDate(parsedDate) };
  await autocabRequest(url, { method: "PUT", body: JSON.stringify(updated) });
  permitDetailCache.delete(String(vehicleId));
  const verified = await autocabRequest(url);
  const verifiedDate = dateKey(verified.motExpiryDate);
  if (verifiedDate !== requested) throw new Error(`Verification failed. Autocab returned ${verifiedDate || "no permit date"}.`);
  const result = {
    status: action === "create" ? "created" : "updated",
    message: action === "create" ? "Permit created and verified in Autocab." : "Permit updated and verified in Autocab.",
    previousExpiry: previous,
    verifiedExpiry: verifiedDate,
    vehicle: verified,
  };
  appendAudit({
    timestamp: new Date().toISOString(), sourceFile: action === "create" ? "Manual permit creation" : "Manual permit update",
    rowNumber: "", callsign: verified.callsign, vehicleId: verified.id, registration: verified.registration,
    plateNumber: verified.plateNumber, previousExpiry: previous, newExpiry: requested,
    verifiedExpiry: verifiedDate, status: result.status, message: result.message,
  });
  return result;
}

app.post("/api/permit-manual", requireAdmin, requireCsrf, async (req, res) => {
  try {
    const { vehicleId, registration, plateNumber, permitExpiryDate, action = "update", allowOverwrite = false } = req.body || {};
    if (!vehicleId || !registration || !plateNumber) return res.status(400).json({ error: "Vehicle, registration and plate number are required." });
    const result = await saveManualPermit({ vehicleId, registration, plateNumber, permitExpiryDate, action, allowOverwrite });
    const status = permitStatus(result.verifiedExpiry);
    res.json({ ok: true, ...result, permit: {
      vehicleId: result.vehicle.id, callsign: String(result.vehicle.callsign ?? ""), registration: result.vehicle.registration,
      plateNumber: result.vehicle.plateNumber, permitExpiryDate: result.verifiedExpiry,
      permitExpiryDisplay: displayDate(result.verifiedExpiry), status: status.key, statusLabel: status.label,
      daysUntilExpiry: status.days,
    }});
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});


app.post("/api/gwr-permit/:vehicleId", requireAdmin, requireCsrf, photoUpload.single("photo"), async (req,res)=>{
  try{
    const vehicleId=String(req.params.vehicleId); const current=await autocabRequest(`https://autocab-api.azure-api.net/vehicle/v1/vehicles/${encodeURIComponent(vehicleId)}`);
    const driverName=String(req.body.driverName||"").trim(), driverNumber=String(req.body.driverNumber||"").trim();
    if(!driverName) return res.status(400).json({error:"Enter the driver's full name."});
    if(!driverNumber) return res.status(400).json({error:"Enter the driver badge or licence number."});
    const permits=readGwrPermits(), old=permits[vehicleId]||{};
    if(req.file && old.photoFile){try{fs.unlinkSync(path.join(GWR_PHOTO_DIR,old.photoFile))}catch{}}
    const record={vehicleId:Number(current.id),callsign:String(current.callsign??""),registration:String(current.registration??""),plateNumber:String(current.plateNumber??""),driverName,driverNumber,permitExpiryDate:dateKey(current.motExpiryDate),photoFile:req.file?.filename||old.photoFile||null,updatedAt:new Date().toISOString()};
    permits[vehicleId]=record;writeGwrPermits(permits);appendAudit({timestamp:record.updatedAt,sourceFile:"GWR display permit",vehicleId:current.id,callsign:current.callsign,registration:current.registration,plateNumber:current.plateNumber,newExpiry:record.permitExpiryDate,status:"gwr_permit_saved",message:`GWR display permit saved for ${driverName}.`});
    res.json({ok:true,record,printUrl:`/gwr-permit/${vehicleId}`});
  }catch(error){res.status(error.status||500).json({error:error.message});}
});
app.get("/api/gwr-permit/:vehicleId", requireAdmin, async(req,res)=>{try{const records=readGwrPermits();const record=records[String(req.params.vehicleId)]||null;if(!record)return res.status(404).json({error:"No GWR display permit has been created for this vehicle."});res.json({record});}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/gwr-permit-photo/:vehicleId", requireAdmin, (req,res)=>{const record=readGwrPermits()[String(req.params.vehicleId)];if(!record?.photoFile)return res.status(404).end();res.sendFile(path.join(GWR_PHOTO_DIR,record.photoFile));});
app.get("/gwr-permit/:vehicleId", requireAdmin, (_req,res)=>res.sendFile(path.join(__dirname,"public","gwr-permit-print.html")));

app.get("/api/permit-audit", requireAdmin, (_req, res) => {
  try {
    const rows = fs.existsSync(AUDIT_FILE)
      ? fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).reverse().slice(0, 250)
      : [];
    res.json({ rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ---------- Main pages and static files ----------

// Main domain opens the secure dashboard.
// Users who are not signed in will be redirected to /permit-login.
app.get("/", requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "permit-manager.html"));
});

// Public station rank screen.
app.get("/rank", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check for Coolify.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Static assets must come after the explicit page routes.
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
}));
