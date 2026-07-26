import { requireRole } from "./_auth.js";
import {
  prepareNoestPayload,
  noestPost,
  formatNoestError,
  isCommuneValidationError,
  updateSupabase,
  logHistory,
} from "./_ship-order.js";

function changedByOf(auth) {
  return auth.role?.name || auth.role?.email || auth.user?.email || auth.role?.role || "operator";
}

// Send one chunk of orders to Noest's bulk create endpoint.
async function bulkCreate(noestGuid, noestToken, items, useFallback) {
  const body = {
    user_guid: noestGuid,
    orders: items.map((v) => {
      const src = useFallback ? v.fallbackPayload : v.payload;
      const { user_guid, ...rest } = src; // user_guid goes at top level for bulk
      return rest;
    }),
  };
  return noestPost("/create/orders", body, noestToken);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireRole(req, ["operator", "admin"]);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const { orders } = req.body || {};
  if (!Array.isArray(orders) || !orders.length) {
    return res.status(400).json({ error: "No orders provided" });
  }

  const noestToken = process.env.NOEST_API_KEY;
  const noestGuid = process.env.NOEST_GUID;
  if (!noestToken || !noestGuid) {
    return res.status(500).json({ error: "Noest credentials not configured" });
  }

  const results = {};   // orderId -> { success, tracking_number } | { error }
  const valid = [];     // prepared, validated orders

  // 1) Validate + build payloads (orders that fail validation are reported, not sent).
  for (const item of orders) {
    const { orderId, order, stationCode } = item || {};
    if (!orderId || !order) {
      if (orderId) results[orderId] = { error: "Missing order data" };
      continue;
    }
    const prep = prepareNoestPayload({ order, orderId, stationCode, noestGuid });
    if (!prep.ok) {
      results[orderId] = { error: prep.error };
      continue;
    }
    valid.push({ orderId, order, ...prep });
  }

  // 2) Create on Noest in chunks of 100 (bulk endpoint max), with a commune-less retry.
  const CHUNK = 100;
  const toUpdate = []; // { orderId, order, tracking }

  for (let i = 0; i < valid.length; i += CHUNK) {
    const slice = valid.slice(i, i + CHUNK);
    const resp = await bulkCreate(noestGuid, noestToken, slice, false);
    const passed = resp.data?.passed || {};
    const failed = resp.data?.failed || {};
    const retry = [];

    slice.forEach((v, idx) => {
      const p = passed[idx];
      if (p && p.tracking) {
        toUpdate.push({ orderId: v.orderId, order: v.order, tracking: p.tracking });
      } else {
        const f = failed[idx];
        if (!v.isStopDesk && isCommuneValidationError(f)) {
          retry.push(v); // retry home-delivery commune errors without commune
        } else {
          results[v.orderId] = { error: formatNoestError(f) || `Noest create failed (HTTP ${resp.status})` };
        }
      }
    });

    if (retry.length) {
      const resp2 = await bulkCreate(noestGuid, noestToken, retry, true);
      const passed2 = resp2.data?.passed || {};
      const failed2 = resp2.data?.failed || {};
      retry.forEach((v, j) => {
        const p = passed2[j];
        if (p && p.tracking) {
          toUpdate.push({ orderId: v.orderId, order: v.order, tracking: p.tracking });
        } else {
          results[v.orderId] = { error: formatNoestError(failed2[j]) || "Noest create failed" };
        }
      });
    }
  }

  // 3) Persist shipped status + tracking, and log history.
  const changedBy = changedByOf(auth);
  for (const u of toUpdate) {
    try {
      await updateSupabase(u.orderId, {
        status: "shipped",
        tracking_number: u.tracking,
        shipping_agency: "noest",
      });
      await logHistory(u.order.order_id, "confirmed", "shipped", changedBy);
      results[u.orderId] = { success: true, tracking_number: u.tracking };
    } catch (err) {
      results[u.orderId] = {
        error: "Shipped on Noest but DB update failed: " + err.message,
        tracking_number: u.tracking,
      };
    }
  }

  const shipped = Object.values(results).filter((r) => r.success).length;
  return res.status(200).json({ results, shipped, total: orders.length });
}
