# Rainbrush — Desktop

Weather alerts for smallholder farmers. Windows 11 desktop application.

## What it does

- Registers farmers with location, crop, planting date, language, and channels
- Fetches 7-day forecasts from Open-Meteo (falls back to modelled data offline)
- Generates alerts in English and Kiswahili
- Sends SMS via Africa's Talking or Twilio
- Places voice calls via Africa's Talking with inline Say actions
- Syncs forecasts and farmers to a USSD relay
- Tracks delivery receipts and call statuses
- Runs a background scheduler every 6 hours
- Persists everything to SQLite

## Quick start

    npm install
    npm run prepare-icons
    npm start

Runs in dry-run mode. Nothing is sent until you configure credentials
and set SMS_DRY_RUN=0.

## Configuration

Edit `.env`. Restart the app after any change.

### SMS

Africa's Talking:
    SMS_PROVIDER=africastalking
    AT_API_KEY=your_key
    AT_USERNAME=your_username
    AT_SENDER_ID=RAINBRUSH

Twilio:
    SMS_PROVIDER=twilio
    TWILIO_ACCOUNT_SID=ACxxx
    TWILIO_AUTH_TOKEN=your_token
    TWILIO_FROM=+15551234567

### Voice

Buy a virtual number in the AT dashboard (Voice > Phone Numbers):

    AT_CALLER_ID=+254711000000

### USSD relay

Deploy the relay (see ussd-relay/README.md), then:

    USSD_RELAY_URL=https://rainbrush-ussd.fly.dev
    USSD_RELAY_SECRET=your_shared_secret

### Going live

When you are ready:

    SMS_DRY_RUN=0

Then delete the seed farmers from the Gallery, or leave ALLOW_SEED_SEND=0
to protect them automatically.

## Building the installer

    npm run dist:win

Outputs to `dist/`:

- `Rainbrush-Setup-0.1.0-x64.exe` — NSIS installer
- `Rainbrush-0.1.0-x64.exe` — portable

## Data location

`%APPDATA%\Rainbrush\`

- `rainbrush.db` — SQLite database
- `sms.log` — SMS dry-run log
- `voice.log` — voice call log
- `scheduler.log` — background cycle log
- `receipts.log` — delivery poller log
- `ussd.log` — relay sync log

## Changelog of what's wired

Everything below is live and connected:

- SMS dispatch with 160-char single-segment templates
- Voice calls with inline Say (no callback server needed)
- USSD served from a cached relay that keeps working offline
- Delivery receipts polled with backoff
- Background scheduler with deduplication
- CSV bulk import with column mapping
- Farmer editor with alert history
- Seed-data guard preventing accidental live sends