/**
 * api/track-orders.js
 * 
 * Auto-tracking system for ARCO COD CRM
 * Polls Noest Express API every 30 minutes (via pg_cron)
 * Tracks: picked up by driver, out for delivery, delivered, suspended, returned
 * Updates order statuses + logs changes to order_history
 */

import { createClient } from "@supabase/supabase-js";
import { isAuthorizedCronRequest, requireRole } from "./_auth.js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const noestApiKey = process.env.NOEST_API_KEY;
const noestGuid = process.env.NOEST_GUID;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const NOEST_BASE = "https://app.noest-dz.com/api/public";

/**
 * Map Noest event keys to ARCO order statuses.
 * We keep the map broad because Noest can return slightly different
 * keys depending on carrier, language, or API version.
 */
const EVENT_STATUS_MAP = {
  // ── In transit / out for delivery ──
  upload: "shipping",                            // uploaded to Noest system
  customer_validation: "shipping",               // validated by partner
  validation_collect_colis: "shipping",          // package picked up from partner
  validation_reception_admin: "shipping",        // reception validated by admin
  validation_reception: "shipping",              // picked up by driver
  fdr_activated: "shipping",                     // route sheet activated
  sent_to_redispatch: "shipping",                // being reassigned
  nouvel_tentative_asked_by_customer: "shipping",// new attempt requested
  mise_a_jour: "shipping",                       // delivery attempt made
  return_redispatched_to_livraison: "shipping",  // return put back out for delivery
  out_for_delivery: "shipping",
  picked_up_by_driver: "shipping",

  // ── Delivered ──
  livre: "delivered",
  livred: "delivered",
  delivered: "delivered",
  pickedup: "shipping",                          // parcel picked up by Noest driver from partner
  valid_return_pickup: "shipping",               // pickup validated
  pickup_picked_recu: "shipping",               // pickup received by Noest partner
  verssement_admin_cust: "delivered",            // cash transmitted to partner
  validation_reception_cash_by_partener: "delivered",
  amount_transmitted_to_partner: "delivered",
  amount_received_by_partner: "delivered",
  echange_valide: "delivered",
  echange_valid_by_hub: "delivered",
  colis_pickup_transmit_to_partner: "returned",  // stop desk pickup sent back to partner (customer didn't collect)

  // ── Suspended — driver couldn't reach customer, still in process ──
  colis_suspendu: "shipping",
  suspended: "shipping",

  // ── Returned ──
  return_asked_by_customer: "returned",
  return_asked_by_hub: "returned",
  retour_dispatched_to_partenaires: "returned",
  return_dispatched_to_partenaire: "returned",
  return_dispatched_to_partner: "returned",
  colis_retour_transmit_to_partner: "returned",
  livraison_echoue_recu: "returned",
  return_validated_by_partener: "returned",
  return_validated_by_partner: "returned",
  return_dispatched_to_warehouse: "returned",
  return_received_by_partner: "returned",
  return_requested_by_partner: "returned",
  return_in_transit: "returned",
  return_package_transmitted_to_partner: "returned",
  annulation_dispatch_retour: "returned",        // return transmission cancelled = back to partner
  cancel_return_dispatched_to_partenaire: "returned",
};

/**
 * Noest payment event keys — when we see these, Noest has signaled
 * that they've transmitted COD cash back to us. We record them in
 * noest_payment_events for reconciliation against manual payouts.
 */
const PAYMENT_EVENT_KEYS = new Set([
  "verssement_admin_cust",
  "validation_reception_cash_by_partener",
  "amount_transmitted_to_partner",
  "amount_received_by_partner",
]);

/**
 * Statuses that are terminal (don't need tracking anymore)
 */
const TERMINAL_STATUSES = [
  "delivered",
  "canceled",
  "returned",
  // "suspended" removed — Noest can reattempt suspended orders,
  // so we keep watching them until they resolve to delivered or returned
  "not_delivered",
  "duplicated",
];

export default async function handler(req, res) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  
  console.log(`[track-orders] ${timestamp} — Starting batch tracking...`);

  try {
    if (!isAuthorizedCronRequest(req)) {
      const auth = await requireRole(req, ["operator", "admin"]);
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.error });
      }
    }

    if (!supabaseUrl || !supabaseServiceKey || !noestApiKey || !noestGuid) {
      console.error("[track-orders] Missing required environment variables");
      return res.status(500).json({ error: "Configuration error: missing env vars" });
    }

    // Fetch all orders that need tracking (non-terminal, with tracking numbers)
    const { data: orders, error: fetchError } = await supabase
      .from("orders")
      .select("id, order_id, tracking_number, status, name, phone, product, variable, prix_total")
      .not("tracking_number", "is", null)
      .not("status", "in", `(${TERMINAL_STATUSES.map(s => `"${s}"`).join(",")})`);

    if (fetchError) {
      console.error("[track-orders] Fetch error:", fetchError);
      return res.status(500).json({ error: "Failed to fetch orders", details: fetchError.message });
    }

    const totalOrders = orders?.length || 0;
    console.log(`[track-orders] Found ${totalOrders} orders to track`);

    if (totalOrders === 0) {
      return res.status(200).json({
        message: "Tracking complete",
        timestamp,
        orders_checked: 0,
        orders_updated: 0,
        errors: 0,
        duration_ms: Date.now() - startTime,
      });
    }

    let updated = 0;
    let errors = 0;
    const updates = [];

    // 1) Ask Noest about every parcel in a handful of batched requests.
    const trackingNumbers = [...new Set(orders.map(o => o.tracking_number).filter(Boolean))];
    const eventMap = await getNoestEventsBatch(trackingNumbers);
    console.log(`[track-orders] Got Noest data for ${eventMap.size}/${trackingNumbers.length} trackings`);

    // 2) Decide the new status for each order; collect writes (no DB call yet).
    const idsByStatus = {};       // newStatus -> [order.id]
    const historyRows = [];       // single bulk insert
    const paymentEventRows = [];  // noest payment signals to persist

    for (const order of orders) {
      const latestEvent = eventMap.get(order.tracking_number);
      if (!latestEvent) continue;

      // ── Detect payment signals from ALL activity (not just latest event) ──
      // We scan the full activity list to catch payment events even if a newer
      // non-payment event is the "latest" one.
      const allActivity = eventMap.getRawActivity
        ? eventMap.getRawActivity(order.tracking_number)
        : [];
      const paymentActivities = allActivity.filter(act => {
        const key = normalizeNoestEventKey(act.event_key || act.event || act.status || "");
        return PAYMENT_EVENT_KEYS.has(key);
      });
      for (const pa of paymentActivities) {
        const pKey = normalizeNoestEventKey(pa.event_key || pa.event || "");
        paymentEventRows.push({
          tracking_number: order.tracking_number,
          order_id: order.order_id,
          order_amount: Number(order.prix_total || 0),
          event_key: pKey,
          event_date: pa.date || null,
        });
      }
      // Also check the latestEvent itself
      if (PAYMENT_EVENT_KEYS.has(latestEvent.event_key)) {
        paymentEventRows.push({
          tracking_number: order.tracking_number,
          order_id: order.order_id,
          order_amount: Number(order.prix_total || 0),
          event_key: latestEvent.event_key,
          event_date: latestEvent.date || null,
        });
      }

      const newStatus = EVENT_STATUS_MAP[latestEvent.event_key];
      if (!newStatus || newStatus === order.status) continue;

      (idsByStatus[newStatus] = idsByStatus[newStatus] || []).push(order.id);
      historyRows.push({
        order_id: order.order_id,
        old_status: order.status,
        new_status: newStatus,
        field_name: null,
        changed_by: "auto_tracker",
        changed_at: timestamp,
      });
      updates.push({ order_id: order.order_id, from: order.status, to: newStatus, event: latestEvent.event_key });
    }

    // 3) Apply status changes grouped by target status — a few queries, not hundreds.
    for (const [newStatus, ids] of Object.entries(idsByStatus)) {
      const { error: updateError } = await supabase
        .from("orders")
        .update({ status: newStatus, updated_at: timestamp })
        .in("id", ids);
      if (updateError) {
        console.error(`[track-orders] bulk update failed for "${newStatus}":`, updateError);
        errors += ids.length;
      } else {
        updated += ids.length;
      }
    }

    // 4) Log all status changes to history in one insert.
    if (historyRows.length) {
      const { error: historyError } = await supabase.from("order_history").insert(historyRows);
      if (historyError) {
        console.error(`[track-orders] bulk history insert failed:`, historyError);
        errors++;
      }
    }

    // 4b) Persist Noest payment events (upsert — unique on tracking+event_key).
    if (paymentEventRows.length) {
      const dedupedPayments = [];
      const seen = new Set();
      for (const row of paymentEventRows) {
        const k = `${row.tracking_number}|${row.event_key}`;
        if (!seen.has(k)) { seen.add(k); dedupedPayments.push(row); }
      }
      const { error: paymentError } = await supabase
        .from("noest_payment_events")
        .upsert(dedupedPayments, { onConflict: "tracking_number,event_key", ignoreDuplicates: true });
      if (paymentError) {
        console.warn(`[track-orders] payment events insert failed (non-fatal):`, paymentError.message);
      } else {
        console.log(`[track-orders] Recorded ${dedupedPayments.length} Noest payment events`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[track-orders] ✅ Complete: checked=${totalOrders}, updated=${updated}, errors=${errors}, took=${duration}ms`
    );

    return res.status(200).json({
      message: "Tracking complete",
      timestamp,
      orders_checked: totalOrders,
      orders_updated: updated,
      errors,
      duration_ms: duration,
      updates,
    });

  } catch (err) {
    console.error("[track-orders] Fatal error:", err.message);
    return res.status(500).json({
      error: "Tracking failed",
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Get the latest event from Noest for a tracking number
 * Calls /api/public/get/trackings/info and returns the most recent activity
 */
// Resolve one parcel's activity history into its most recent meaningful status.
function resolveActivityToEvent(orderData) {
  if (!orderData || !Array.isArray(orderData.activity) || orderData.activity.length === 0) {
    return null;
  }
  const activity = [...orderData.activity].sort(
    (a, b) => parseNoestDate(b?.date) - parseNoestDate(a?.date)
  );
  let newest = null;
  for (const act of activity) {
    const key = normalizeNoestEventKey(
      act.event_key || act.event || act.status || act.label || ""
    );
    if (!newest) newest = { event_key: key, event_name: act.event, date: act.date };
    if (EVENT_STATUS_MAP[key]) {
      return { event_key: key, event_name: act.event, date: act.date };
    }
  }
  return newest;
}

// Ask Noest about MANY parcels at once. get/trackings/info accepts an array,
// so we request in chunks (≈6 calls for 300 orders) instead of one call each.
// Returns Map<tracking_number, resolvedEvent>.
async function getNoestEventsBatch(trackingNumbers) {
  const out = new Map();
  const rawActivityMap = new Map(); // tracking -> full activity array
  const CHUNK = 50;
  for (let i = 0; i < trackingNumbers.length; i += CHUNK) {
    const batch = trackingNumbers.slice(i, i + CHUNK);
    try {
      const response = await fetch(`${NOEST_BASE}/get/trackings/info`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${noestApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_guid: noestGuid, trackings: batch }),
      });
      if (!response.ok) {
        console.warn(`[track-orders] batch HTTP ${response.status} for ${batch.length} trackings`);
        continue;
      }
      const data = await response.json();
      for (const t of batch) {
        const orderData = data?.[t];
        const ev = resolveActivityToEvent(orderData);
        if (ev) out.set(t, ev);
        // Store full activity for payment event scanning
        if (Array.isArray(orderData?.activity)) {
          rawActivityMap.set(t, orderData.activity);
        }
      }
    } catch (err) {
      console.error(`[track-orders] batch error:`, err.message);
    }
  }
  // Attach helper so caller can get raw activity
  out.getRawActivity = (tracking) => rawActivityMap.get(tracking) || [];
  return out;
}

function parseNoestDate(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNoestEventKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ÃÂ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s\-\/]+/g, "_")
    .replace(/[^\p{L}\p{N}_]+/gu, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}
