# Azyaa CRM setup

This repository is an operator-only CRM for Shopify orders and Noest shipping. It does not include customer notifications, storefront pages, Meta/TikTok tracking, or the ARCO tracker app.

## 1. Supabase

1. Open the new Supabase project.
2. Open **SQL Editor**.
3. Run `supabase-azyaa-crm.sql`.
4. Create the operator in **Authentication → Users**.
5. Copy that user's UUID and run the final `insert into public.user_roles` statement from the SQL file.
6. Add the store's products and shipping rates, or import them before using manual order creation.

The frontend still needs the new project's URL and anon key in `public/operator.html` at the `SB_URL`, `SB_KEY`, and `SB_PROJECT` constants.

## 2. Vercel environment variables

Add these variables to the Vercel project:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NOEST_API_KEY`
- `NOEST_GUID`
- `SHOPIFY_WEBHOOK_SECRET`

Never put the service-role key, Noest credentials, or Shopify secret in the frontend.

## 3. Shopify webhook

Create a Shopify custom app for the store and register:

- Event: `orders/create`
- Optional events: `orders/updated`, `orders/cancelled`
- URL: `https://YOUR-VERCEL-DOMAIN/api/shopify-webhook`

The webhook maps the Shopify order into `public.orders`. It uses the Shopify order name as `order_id`, marks it as a real non-draft order, and keeps the product subtotal separate from delivery cost.

The Shopify address must contain an Algerian wilaya/province and commune/city. If Shopify sends only a code such as `DZ-16`, the operator should correct the wilaya before sending the order to Noest.

## 4. Noest tracking

The **Track Noest** button in the operator header calls `/api/track-orders`. It updates the order and writes status changes to `order_history`. The existing Noest mapping handles delivered and returned events.

The tracker is manual in this clone: click **Track Noest** whenever you want to refresh statuses. No push or ntfy notifications are used.

## 5. Deploy

1. Connect this repository to Vercel.
2. Add the environment variables above.
3. Deploy.
4. Open `/operator.html` and sign in with the Supabase operator account.
5. Register the Shopify webhook only after the deployment URL is live.
