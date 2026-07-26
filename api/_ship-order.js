import { requireRole } from "./_auth.js";

const NOEST_BASE = "https://app.noest-dz.com/api/public";

const WILAYA_MAP = {
  adrar: 1, chlef: 2, laghouat: 3, "oum el bouaghi": 4, batna: 5,
  bejaia: 6, biskra: 7, bechar: 8, blida: 9, bouira: 10,
  tamanrasset: 11, tebessa: 12, tlemcen: 13, tiaret: 14, "tizi ouzou": 15,
  alger: 16, djelfa: 17, jijel: 18, setif: 19, saida: 20,
  skikda: 21, "sidi bel abbes": 22, annaba: 23, guelma: 24, constantine: 25,
  medea: 26, mostaganem: 27, msila: 28, mascara: 29, ouargla: 30,
  oran: 31, "el bayadh": 32, illizi: 33, "bordj bou arreridj": 34, boumerdes: 35,
  "el tarf": 36, tindouf: 37, tissemsilt: 38, "el oued": 39, khenchela: 40,
  "souk ahras": 41, tipaza: 42, mila: 43, "ain defla": 44, naama: 45,
  "ain temouchent": 46, ghardaia: 47, relizane: 48, timimoun: 49,
  "bordj badji mokhtar": 50, "ouled djellal": 51, "beni abbes": 52,
  "in salah": 53, "in guezzam": 54, touggourt: 55, djanet: 56,
  "el meghaier": 57, "el meniaa": 58,
};

const WILAYA_ALIASES = {
  "bordj bou arriedj": 34,
  "bordj bou arreridj": 34,
  "bordj bou arrÃ©ridj": 34,
  "bordj bou arréridj": 34,
  "setif": 19,
  "sétif": 19,
  "sÃ©tif": 19,
  "medea": 26,
  "médéa": 26,
  "mÃ©dÃ©a": 26,
  "ain defla": 44,
  "aïn defla": 44,
};

const COMMUNE_ALIASES = {
  16: {
    "bir touta": "Birtouta",
    "bir khadem": "Birkhadem",
  },
  27: {
    "hassi mameche": "Hassi Maameche",
  },
  42: {
    "cherchell": "Cherchel",
  },
};

function getWilayaId(wilayaName) {
  if (!wilayaName) return null;
  const raw = String(wilayaName).trim();
  const rawLower = raw.toLowerCase();
  if (rawLower === "m'sila" || rawLower === "m’sila" || rawLower === "msila") return 28;
  const candidates = [raw, decodeMojibake(raw)];

  for (const candidate of candidates) {
    const cleaned = normalizeWilayaKey(candidate);
    if (cleaned && WILAYA_MAP[cleaned]) return WILAYA_MAP[cleaned];
    if (cleaned && WILAYA_ALIASES[cleaned]) return WILAYA_ALIASES[cleaned];
  }

  return null;
}

function decodeMojibake(value) {
  const text = String(value || "");
  if (!/[ÃÂ]/.test(text)) return text;
  try {
    return new TextDecoder("utf-8").decode(Uint8Array.from(text, (ch) => ch.charCodeAt(0)));
  } catch {
    return text;
  }
}

function stripDiacritics(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeWilayaKey(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .trim()
    .replace("algiers", "alger")
    .replace(/^\d+\s*-\s*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function sanitizeNoestText(value, fallback = "") {
  const normalized = String(value || fallback || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s\-.,/()]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || String(fallback || "").trim();
}

function buildNoestReference(orderId, orderRef) {
  const safeRef = String(orderRef || orderId || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(-30);

  return `ARCO-${safeRef || orderId}`;
}

function normalizeStationCode(stationCode) {
  const raw = String(stationCode || "").trim().toUpperCase();
  if (!raw) return "";

  const match = raw.match(/^0*(\d+)([A-Z]+)$/);
  if (!match) return raw;

  return `${Number(match[1])}${match[2]}`;
}

function normalizeCommuneForNoest(wilayaId, commune) {
  const raw = sanitizeNoestText(commune || "", "");
  if (!raw) return "";

  const key = normalizeWilayaKey(raw);
  const aliases = COMMUNE_ALIASES[Number(wilayaId)] || {};
  return aliases[key] || raw;
}

async function noestPost(endpoint, body, token) {
  const response = await fetch(`${NOEST_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

function formatNoestError(data) {
  if (!data) return "Noest create failed";
  if (typeof data === "string") return data;
  const pieces = [];
  if (data.message) pieces.push(String(data.message));
  if (data.error) pieces.push(String(data.error));
  if (Array.isArray(data.errors) && data.errors.length) {
    pieces.push(`errors: ${data.errors.map((e) => JSON.stringify(e)).join(" | ")}`);
  }
  if (data.details) pieces.push(`details: ${JSON.stringify(data.details)}`);
  if (data.validation) pieces.push(`validation: ${JSON.stringify(data.validation)}`);
  if (data.field) pieces.push(`field: ${JSON.stringify(data.field)}`);
  if (!pieces.length) pieces.push(JSON.stringify(data));
  return pieces.join(" ; ");
}

function isCommuneValidationError(data) {
  const text = JSON.stringify(data || {}).toLowerCase();
  return text.includes("commune") && (text.includes("invalid") || text.includes("invalide"));
}

// Build the "produit" text sent to the shipping agency.
// Cart orders: list each item as "name size" so the agency sees real
// product detail instead of just "basket of N pieces" + sizes.
// Single-product orders: unchanged (product - variant).
function buildProduitText(order) {
  if (Array.isArray(order.items) && order.items.length) {
    const parts = order.items
      .map((it) => {
        const name = it.product || it.product_slug || it.slug || "";
        const size = it.size || it.variant || "";
        return [name, size].filter(Boolean).join(" ");
      })
      .filter(Boolean);
    if (parts.length) {
      const list = parts.join(", ").slice(0, 220);
      return `${order.items.length} قطع - ${list}`;
    }
  }
  return order.product + (order.variable ? ` - ${order.variable}` : "");
}

function buildNoestPayload({ noestGuid, orderId, order, wilayaId, phone, clientName, address, commune, isStopDesk, normalizedStationCode }) {
  return {
    user_guid: noestGuid,
    reference: buildNoestReference(orderId, order.order_id),
    client: clientName,
    phone,
    adresse: address,
    wilaya_id: wilayaId,
    ...(commune ? { commune } : {}),
    montant: parseFloat(order.prix_total || 0),
    produit: sanitizeNoestText(buildProduitText(order), "Commande ARCO"),
    type_id: 1,
    stop_desk: isStopDesk ? 1 : 0,
    can_open: 1,
    poids: 0.5,
    ...(isStopDesk && normalizedStationCode ? { station_code: normalizedStationCode } : {}),
  };
}

async function updateSupabase(orderId, fields) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${url}/rest/v1/orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(fields),
  });
}

async function logHistory(orderRef, oldStatus, newStatus, changedBy) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${url}/rest/v1/order_history`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      order_id: orderRef,
      old_status: oldStatus,
      new_status: newStatus,
      changed_by: changedBy || "operator",
    }),
  });
}

// Build (and validate) a Noest payload for one order without sending it.
// Returns { ok:true, payload, fallbackPayload, isStopDesk } or { ok:false, error }.
export function prepareNoestPayload({ order, orderId, stationCode, noestGuid }) {
  const wilayaId = getWilayaId(order.wilaya);
  if (!wilayaId) {
    return { ok: false, error: `Unknown wilaya: "${order.wilaya}". Edit the order and fix the wilaya first.` };
  }
  const phone = normalizePhone(order.phone);
  if (phone.length < 8) {
    return { ok: false, error: `Invalid phone number: "${order.phone}". Use digits only.` };
  }
  const isStopDesk = order.type_livraison === "pickup";
  const normalizedStationCode = normalizeStationCode(stationCode || order.station_code);
  const clientName = sanitizeNoestText(order.name, `Client ${orderId}`);
  const address = sanitizeNoestText(order.commune || order.wilaya, order.wilaya || "Algerie");
  const commune = normalizeCommuneForNoest(wilayaId, order.commune || "");
  const payload = buildNoestPayload({ noestGuid, orderId, order, wilayaId, phone, clientName, address, commune, isStopDesk, normalizedStationCode });
  const fallbackPayload = buildNoestPayload({ noestGuid, orderId, order, wilayaId, phone, clientName, address, commune: "", isStopDesk, normalizedStationCode });
  return { ok: true, payload, fallbackPayload, isStopDesk };
}

export { noestPost, formatNoestError, isCommuneValidationError, updateSupabase, logHistory };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireRole(req, ["operator", "admin"]);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const { orderId, order, stationCode } = req.body || {};
  if (!orderId || !order) {
    return res.status(400).json({ error: "Missing orderId or order data" });
  }

  const noestToken = process.env.NOEST_API_KEY;
  const noestGuid = process.env.NOEST_GUID;
  if (!noestToken || !noestGuid) {
    return res.status(500).json({ error: "Noest credentials not configured" });
  }

  const wilayaId = getWilayaId(order.wilaya);
  if (!wilayaId) {
    return res.status(400).json({
      error: `Unknown wilaya: "${order.wilaya}". Please edit the order and fix the wilaya first.`,
    });
  }

  const phone = normalizePhone(order.phone);
  if (phone.length < 8) {
    return res.status(400).json({
      error: `Invalid phone number: "${order.phone}". Please edit the order and use digits only.`,
    });
  }

  const isStopDesk = order.type_livraison === "pickup";
  const normalizedStationCode = normalizeStationCode(stationCode || order.station_code);
  const clientName = sanitizeNoestText(order.name, `Client ${orderId}`);
  const address = sanitizeNoestText(order.commune || order.wilaya, order.wilaya || "Algerie");
  const commune = normalizeCommuneForNoest(wilayaId, order.commune || "");
  const primaryPayload = buildNoestPayload({
    noestGuid,
    orderId,
    order,
    wilayaId,
    phone,
    clientName,
    address,
    commune,
    isStopDesk,
    normalizedStationCode,
  });

  let createRes = await noestPost("/create/order", primaryPayload, noestToken);
  let usedFallbackPayload = false;
  let fallbackPayload = null;

  if (!createRes.ok || !createRes.data?.success) {
    const shouldRetryWithoutCommune = !isStopDesk && isCommuneValidationError(createRes.data);
    if (shouldRetryWithoutCommune) {
      fallbackPayload = buildNoestPayload({
        noestGuid,
        orderId,
        order,
        wilayaId,
        phone,
        clientName,
        address,
        commune: "",
        isStopDesk,
        normalizedStationCode,
      });
      createRes = await noestPost("/create/order", fallbackPayload, noestToken);
      usedFallbackPayload = true;
    }
  }

  if (!createRes.ok || !createRes.data?.success) {
    const errMsg = formatNoestError(createRes.data);
    console.error("Noest create error:", {
      status: createRes.status,
      orderId,
      orderRef: order.order_id,
      payload: usedFallbackPayload ? fallbackPayload : primaryPayload,
      fallbackPayload,
      response: createRes.data,
      message: errMsg,
    });
    return res.status(400).json({
      error: errMsg,
      noest_status: createRes.status,
      noest_response: createRes.data,
      retried_without_commune: usedFallbackPayload,
    });
  }

  const tracking = createRes.data.tracking;
  if (!tracking) {
    return res.status(400).json({ error: "No tracking number returned from Noest" });
  }

  await updateSupabase(orderId, {
    status: "shipped",
    tracking_number: tracking,
    shipping_agency: "noest",
  });

  await logHistory(
    order.order_id,
    "confirmed",
    "shipped",
    auth.role?.name || auth.role?.email || auth.user?.email || auth.role?.role || "operator"
  );

  return res.status(200).json({
    success: true,
    tracking_number: tracking,
  });
}
