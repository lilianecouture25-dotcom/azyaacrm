import { getServiceClient, requireRole } from "./_auth.js";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  return clean(value).replace(/\s+/g, "");
}

function createOrderId() {
  return `${Date.now()}${Math.floor(100 + Math.random() * 900)}`;
}

function resolveVariant(product, payload) {
  const raw = product.variants;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") {
    list = Object.entries(raw).map(([name, value]) =>
      typeof value === "object" ? { name, ...value } : { name, price: value }
    );
  }
  if (!list.length) return { name: "Standard", label: "Standard", price: Number(product.price || 0) };
  const wanted = clean(payload.variant_label).toLowerCase();
  return list.find((variant) => clean(variant.label || variant.name).toLowerCase() === wanted) || list[0];
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireRole(req, ["operator", "admin"]);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  try {
    const body = req.body || {};
    const name = clean(body.name);
    const phone = normalizePhone(body.phone);
    const wilaya = clean(body.wilaya);
    const commune = clean(body.commune);
    const deliveryType = body.delivery_type === "pickup" ? "pickup" : "home";
    const stationCode = deliveryType === "pickup" ? clean(body.station_code) : null;
    const wilayaId = Number(body.wilaya_id);
    const productSlug = clean(body.product_slug);

    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!/^0[567]\d{8}$/.test(phone)) return res.status(400).json({ error: "Invalid phone number" });
    if (!wilaya || !Number.isInteger(wilayaId) || wilayaId < 1) return res.status(400).json({ error: "Wilaya is required" });
    if (deliveryType === "home" && !commune) return res.status(400).json({ error: "Commune is required for home delivery" });
    if (deliveryType === "pickup" && !stationCode) return res.status(400).json({ error: "Stop Desk is required for pickup" });
    if (!productSlug) return res.status(400).json({ error: "Product is required" });

    const supabase = getServiceClient();
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("name, slug, price, active, variants, type")
      .ilike("slug", productSlug)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (productError || !product) return res.status(404).json({ error: "Product not found" });

    const variant = resolveVariant(product, body);
    const productPrice = Number(variant.price || product.price || 0);
    if (!Number.isFinite(productPrice) || productPrice <= 0) return res.status(400).json({ error: "Invalid product price" });

    const { data: shipping, error: shippingError } = await supabase
      .from("shipping_rates")
      .select("home_delivery, stop_desk")
      .eq("wilaya_id", wilayaId)
      .limit(1)
      .maybeSingle();
    if (shippingError || !shipping) return res.status(400).json({ error: "Shipping is unavailable for this wilaya" });

    const shippingCost = deliveryType === "pickup" ? Number(shipping.stop_desk || 0) : Number(shipping.home_delivery || 0);
    if (!Number.isFinite(shippingCost) || shippingCost <= 0) return res.status(400).json({ error: "Shipping price is unavailable" });

    const order = {
      name,
      phone,
      wilaya,
      commune: deliveryType === "home" ? commune : "",
      type_livraison: deliveryType,
      station_code: stationCode,
      product: product.name,
      variable: variant.label || variant.name || "Standard",
      prix_total: productPrice + shippingCost,
      shipping_cost: shippingCost,
      status: "pending",
      notes: clean(body.notes),
      order_id: createOrderId(),
      attribution_source: "operator",
      attribution_medium: "operator",
      attribution_captured_at: new Date().toISOString(),
    };

    const { error: insertError } = await supabase.from("orders").insert(order);
    if (insertError) {
      console.error("[operator-create-order] insert failed:", insertError);
      return res.status(500).json({ error: "Failed to save order" });
    }

    return res.status(200).json({ ok: true, order_id: order.order_id });
  } catch (error) {
    console.error("[operator-create-order]", error);
    return res.status(500).json({ error: error.message || "Order creation failed" });
  }
}
