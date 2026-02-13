# Deploy to Render + Supabase

## 1) Supabase setup

1. Create a Supabase project.
2. Open SQL editor and run [supabase/schema.sql](supabase/schema.sql).
3. Copy:
   - Project URL -> `SUPABASE_URL`
   - Service role key -> `SUPABASE_SERVICE_ROLE_KEY`

## 2) Render setup

Create a **Web Service** from this repo.

- Build command: `npm install && npm run build`
- Start command: `npm start` (runs backend API server only)
- Runtime: Node 20+

Set environment variables in Render:

- `CANVA_FRONTEND_PORT=8080`
- `CANVA_BACKEND_PORT=3001`
- `CANVA_BACKEND_HOST=https://<your-render-service>.onrender.com`
- `CANVA_APP_ID=<from Canva developer portal>`
- `CANVA_APP_ORIGIN=<from Canva developer portal>`
- `CANVA_HMR_ENABLED=FALSE`
- `REVE_API_KEY=<your key>`
- `LONGCAT_API_KEY=<your key>`
- `LEMON_SQUEEZY_API_KEY=<your key>`
- `LEMON_SQUEEZY_STORE_ID=<store id>`
- `LEMON_SQUEEZY_VARIANT_ID=<variant id>`
- `LEMON_SQUEEZY_WEBHOOK_SECRET=<secret>`
- `SUPABASE_URL=<project url>`
- `SUPABASE_SERVICE_ROLE_KEY=<service role key>`

Local Canva development still uses:

- `npm run start:dev`

## 3) Lemon Squeezy webhook

Set callback URL to:

`https://<your-render-service>.onrender.com/api/billing/lemon/webhook`

Set signing secret to exactly `LEMON_SQUEEZY_WEBHOOK_SECRET`.

## 4) Canva production config

In Canva Developer Portal:

- Set production backend host to your Render URL.
- Upload production app bundle from `npm run build` output.

## 5) Smoke test

1. Open app in Canva.
2. Generate once (free limit currently set to 1).
3. Next attempt should show upgrade.
4. Complete Lemon checkout.
5. Verify generation unlocks.
