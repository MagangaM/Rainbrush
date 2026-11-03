# Rainbrush — project manifest

A weather alert system for smallholder farmers. Windows 11 desktop
app (Electron) + USSD relay (Node.js). Four channels: SMS, voice,
USSD, and in-app preview. Two languages: English and Kiswahili.

## Build order

### Desktop app (desktop/)
1.  package.json          — dependencies, build config
2.  .env / .env.example   — configuration
3.  .gitignore
4.  README.md
5.  assets/icon.svg       — source icon
6.  scripts/make-icons.js — generates .ico/.png/tray
7.  sms-format.js         — GSM-7 encoding analysis
8.  engine.js             — locations, crops, rules, weather
9.  sms.js                — Twilio + Africa's Talking SMS
10. voice.js              — AT voice with inline Say
11. receipts.js           — delivery status poller
12. ussd.js               — relay sync client
13. scheduler.js          — background cycle, dedup
14. main.js               — Electron main, DB, IPC, tray
15. preload.js            — context bridge
16. renderer-csv.js       — CSV import
17. index.html            — full UI

### USSD relay (ussd-relay/)
18. package.json
19. forecast.js           — Open-Meteo client
20. server.js             — Express, USSD handler, refresher
21. Dockerfile
22. fly.toml
23. .env.example
24. .gitignore
25. README.md

## Install and run

Desktop:
    cd desktop
    npm install
    npm run prepare-icons
    npm start

Build Windows installer:
    npm run dist:win

Relay (local):
    cd ussd-relay
    npm install
    node server.js

Relay (production):
    fly launch --no-deploy
    fly secrets set RELAY_SECRET="$(openssl rand -hex 32)"
    fly deploy

## Environment

All configuration lives in desktop/.env. Critical flags:

    SMS_DRY_RUN=1            ← keep this ON until everything is tested
    SCHEDULER_ENABLED=1      ← background cycle
    SCHEDULER_AUTO_SEND=0    ← keep OFF until you trust the output
    ALLOW_SEED_SEND=0        ← NEVER set to 1 in production