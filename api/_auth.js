import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
}

export function getServiceClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase server keys are not configured");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getUserFromRequest(req) {
  const token = getBearerToken(req);
  if (!token) return { token: "", user: null, role: null };

  const admin = getServiceClient();
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    return { token, user: null, role: null };
  }

  // Keep the authenticated user's JWT on the role query as well. This makes
  // the authorization check work reliably with both legacy service_role keys
  // and the newer Supabase secret-key format, while RLS still limits the
  // lookup to the signed-in user's own role row.
  const roleClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: roleData } = await roleClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  return {
    token,
    user: userData.user,
    role: roleData || null,
  };
}

export async function requireRole(req, allowedRoles = []) {
  try {
    const auth = await getUserFromRequest(req);
    if (!auth.user) {
      return { ok: false, status: 401, error: "Unauthorized" };
    }
    if (!auth.role || !allowedRoles.includes(auth.role.role)) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    return { ok: true, ...auth };
  } catch (err) {
    return { ok: false, status: 500, error: err.message || "Auth error" };
  }
}

export function isInternalRequest(req) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return false;
  return req.headers["x-internal-secret"] === secret;
}

export function isAuthorizedCronRequest(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.authorization === `Bearer ${cronSecret}`;
}
