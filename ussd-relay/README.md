# Rainbrush USSD Relay

Bridges Africa's Talking USSD webhooks to the Rainbrush desktop app.

The desktop app can't receive webhooks (it's behind NAT), so this
relay sits on the public internet, serves USSD menus from a cache,
and syncs fresh forecasts from Open-Meteo on a timer. USSD works
even when the desktop studio is closed.

## Why a relay

USSD is the only Rainbrush channel that requires a public callback
URL. SMS and voice both push out from the desktop app; USSD pulls
in. So USSD lives here.

## What it does

- Serves the USSD menu tree to Africa's Talking
- Fetches 7-day forecasts from Open-Meteo every 3 hours
- Caches forecasts in SQLite
- Accepts location and farmer pushes from the desktop app
- Exposes session logs and analytics for the desktop Settings view
- Falls back to a deterministic model if Open-Meteo is unreachable

## Deploy to Fly.io

1. Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
2. `fly auth login`
3. `fly launch --no-deploy` — accept the existing config
4. Generate a secret: