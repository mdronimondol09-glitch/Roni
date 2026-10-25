# Roni Arena

Online 3D shooter. Login (email / mobile / Facebook), friend list + add-link, rooms for 2-10 players, Solo / Duo / Squad (4v4), coins, gun shop + upgrades, topup.

Creative by Roni ©2026

## Run

Needs Node 20+ (no npm install needed, zero dependencies).

```bash
node server.js          # http://localhost:3000
node test/smoke.js      # full automated check (2 simulated players play a match)
```

Phone/friends test korte: server-ta ekta public server-e chalan (VPS, Render, Railway, Fly.io...) ba LAN-e `http://<PC-IP>:3000` open korun. Internet-e dile **HTTPS** use korben (mobile browser fullscreen/PWA er jonno).

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | server port |
| `TARGET_SCORE` | 20 | jitar jonno koto score lagbe |
| `SCORE_MODE` | `kills` | `kills` = 20 kill, `hits` = 20 bar gooli lagle jit |
| `MIN_PLAYERS` | 2 | match start-er jonno minimum player |
| `TOPUP_TEST` | on | `0` dile fake topup bondho (real payment na thakle `0` korun) |
| `FB_APP_ID`, `FB_APP_SECRET` | empty | Facebook login chalu korte dorkar (developers.facebook.com) |
| `RESPAWN_MS` | 3000 | mara jawar por respawn time |

## Game rules (ekhon)

- Solo: sobai alada, max 10. Duo: 2 jon-er team (min 3 jon lagbe). Squad: 4 vs 4 (max 8).
- Machine gun diye shoot. 20 kill age korle team/player win. Winner-der prottekke **100 coin**.
- Coin diye shop theke notun gun kena jay, damage upgrade (Lv1-5, +10% damage prottek level).
- Friend: ID diye add, ba `https://your-site/?add=YOURID` link share. Room-e invite kora jay, online dekha jay.

## Android app

1. **Sobcheye shohoj (PWA):** HTTPS site Chrome-e khule menu > "Add to Home screen". Fullscreen game-er moto khulbe.
2. **Play Store APK:** [Capacitor](https://capacitorjs.com) diye ei `public/` folder wrap kora jay:
   `npm i @capacitor/core @capacitor/cli @capacitor/android`, `npx cap init`, `webDir: "public"`, `server.url` = apnar hosted server, `npx cap add android`, `npx cap open android`.

## Production-er age ja korte hobe

- **Real payment:** bKash / Nagad / SSLCommerz gateway connect korte hobe (ekhon topup shudhu test mode, free coin dey). Payment callback server-e verify kore coin add korbe.
- **Anti-cheat:** ekhon player position client theke ashe, server shudhu fire-rate/range check kore. Public release-er age server-side hit validation lagbe.
- **Database:** ekhon `data/db.json`. Beshi player hole PostgreSQL/MongoDB.
- Rate limiting, password reset, email/SMS OTP verification (mobile number verify korar jonno SMS gateway lagbe).
