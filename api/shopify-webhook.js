import crypto from "node:crypto";
import { getServiceClient } from "./_auth.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  // Shopify signs the exact bytes it sends. Never JSON.stringify a Buffer or
  // parsed object here because even harmless formatting changes invalidate HMAC.
  if (req.rawBody !== undefined && req.rawBody !== null) {
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString("utf8");
    if (req.rawBody instanceof Uint8Array) return Buffer.from(req.rawBody).toString("utf8");
    if (typeof req.rawBody === "string") return req.rawBody;
  }
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body instanceof Uint8Array) return Buffer.from(req.body).toString("utf8");
  if (typeof req.body === "string") return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function verifyShopifyHmac(req, body) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  const received = String(req.headers["x-shopify-hmac-sha256"] || "");
  if (!secret || !received) return false;
  const expected = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const bodyText = await rawBody(req);
  if (!verifyShopifyHmac(req, bodyText)) return res.status(401).json({ error: "Invalid Shopify webhook signature" });

  try {
    const shopifyOrder = JSON.parse(bodyText || "{}");
    const supabase = getServiceClient();
    const address = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};
    const orderId = String(shopifyOrder.name || shopifyOrder.order_number || shopifyOrder.id || "").trim();
    if (!orderId) return res.status(400).json({ error: "Shopify order has no identifier" });

    const { data: existing, error: lookupError } = await supabase
      .from("orders")
      .select("id")
      .eq("order_id", orderId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return res.status(200).json({ ok: true, duplicate: true, order_id: orderId });

    const shippingCost = (shopifyOrder.shipping_lines || []).reduce((sum, line) => sum + number(line.price), 0);
    const productTotal = number(shopifyOrder.current_subtotal_price ?? shopifyOrder.subtotal_price);
    const total = number(shopifyOrder.current_total_price ?? shopifyOrder.total_price) || productTotal + shippingCost;
    const items = (shopifyOrder.line_items || []).map(item => ({
      product: item.title || item.name || "Product",
      quantity: number(item.quantity),
      price: number(item.price),
      variant: item.variant_title || "",
    }));
    const order = {
      order_id: orderId,
      name: `${shopifyOrder.customer?.first_name || ""} ${shopifyOrder.customer?.last_name || ""}`.trim() || address.name || "Shopify customer",
      phone: shopifyOrder.phone || shopifyOrder.customer?.phone || address.phone || "",
      wilaya: address.province || address.province_code || "",
      commune: address.city || "",
      type_livraison: "home",
      station_code: null,
      product: items.map(item => `${item.product}${item.quantity > 1 ? ` x${item.quantity}` : ""}`).join(", "),
      variable: items.map(item => item.variant).filter(Boolean).join(", "),
      items,
      prix_total: total,
      shipping_cost: shippingCost,
      status: "pending",
      from_draft: false,
      attribution_source: "shopify",
      attribution_medium: "shopify",
      notes: `Shopify order ${shopifyOrder.id || orderId}`,
      created_at: shopifyOrder.created_at || new Date().toISOString(),
    };

    const { error } = await supabase.from("orders").insert(order);
    if (error) throw error;
    return res.status(200).json({ ok: true, order_id: orderId });
  } catch (error) {
    console.error("[shopify-webhook]", error);
    return res.status(500).json({ error: "Could not create Shopify order", message: error.message });
  }
}
