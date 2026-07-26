import singleHandler from "./_ship-order.js";
import bulkHandler from "./_ship-orders-bulk.js";

export default async function handler(req, res) {
  const mode = req.query?.mode || new URL(req.url, `https://${req.headers.host || "arco-art.store"}`).searchParams.get("mode");
  return mode === "bulk" ? bulkHandler(req, res) : singleHandler(req, res);
}
