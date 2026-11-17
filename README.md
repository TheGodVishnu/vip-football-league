# VIP FOOTBALL LEAGUE

> **Upgrading to multi-admin / unified points?** Read `DEPLOYMENT-GUIDE.md` first — it needs a one-time Cloud Functions deploy.

Public website (`index.html`) + secure admin panel (`admin.html`), built with plain HTML, CSS and JavaScript,
Firebase Firestore + Authentication, hosted free on Cloudflare Pages.

## Set up (one time) — in this order

### 1. Firebase console (https://console.firebase.google.com → project `society-football-league`)
1. **Build → Authentication → Sign-in method** → enable **Email/Password**.
2. **Authentication → Users** → make sure your admin user exists. Copy its **User UID**.
3. **IMPORTANT – check the UID.** A Firebase UID has 28 characters. The file `firestore.rules` and `js/firebase-config.js`
   contain `w1oMfha7SpV6ogBMDNNGNLDplXs2`. Your two briefs spelled it slightly differently, so compare it with the
   UID in the console. If they differ, replace it in **both files** (and nowhere else).
   After you log in to the admin panel, **Settings → Admin account** also shows ✔ or ✘ for you.
4. **Build → Firestore Database** → create the database (production mode, any region) if it does not exist yet.
5. **Firestore → Rules** → paste the full content of `firestore.rules` → **Publish**.
6. **Authentication → Settings → Authorized domains** → add your Cloudflare Pages domain (e.g. `vip-football-league.pages.dev`).

### 2. Cloudflare Pages
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Upload assets**.
2. Upload the whole `VIP-FOOTBALL-LEAGUE` folder (or the ZIP contents). No build command is needed.
3. Open the `.pages.dev` link. The public site is `/`, the admin panel is `/admin.html`.

### 3. First login
1. Open `/admin.html` → sign in with your admin email + password (stays signed in after closing the browser).
2. Dashboard → **Load initial league data**. This adds the 20 registered players and the historical Match 1.
   It only works on an empty league, so it can never overwrite real data.

## What is where
| File | Purpose |
|---|---|
| `css/theme.css` | **All colours, fonts, card/button looks, backgrounds** – edit this to re-skin the site |
| `css/animations.css` | All animations (and reduced-motion handling) |
| `css/style.css`, `css/admin.css` | Layout of public site / admin panel |
| `js/components.js` | Player card, match card, news card templates |
| `js/site-config.js` | Order of the Home sections, how many featured players, etc. |
| `js/app.js` | Public pages + live Firestore listeners |
| `js/admin.js` | Admin panel |
| `js/lib.js` | Auction maths, stats, ranking (no Firebase code) |
| `js/seed-data.js` | Your 20 players + Match 1 data |
| `firestore.rules` | Public read; only the Owner / active admins write |
| `functions/index.js` | Cloud Functions: username login, create / disable / remove admins |
| `assets/logo.svg` | Logo (replace, or upload another in Settings) |

## Rules used
* **Auction Points** (per captain, per match): `totalBeforeCap = starting + bonus`, `usable = min(total, maxBudget)`,
  `excess = max(0, total − maxBudget)`, `remaining = usable − spent`. All values are stored for every captain in every match.
  Starting points (100) and the max budget (150) are editable in **Settings** and apply to *new* matches.
* **Reward Points = Auction Points** (one shared balance). Captain bonus is taken from it, match rewards are added, redemptions are taken from it.
  The Money Converter is fixed: 250 pts = ₹5, 500 = ₹10, 1000 = ₹20. Earning rules start at 0: you enter points by hand (or fill the rules in Settings).
* **Stats** are always rebuilt from the saved match records (completed matches only), so editing a result never double-counts.
  Manual corrections (Players → *Edit stats*) are stored as a visible adjustment on top of the match records.

## Match 1 (historical) – what was and was not recorded
Recorded: both teams, captains, vice-captains, all 16 auction purchases, goals (2 normal + 3 penalty).
**Not recorded** (not supplied): date, final score, winner, entry fee. These show as “not recorded” and can be filled in later
(Match → Details; re-open the match to declare a result). The 150-point budget is stored as a provisional per-team budget.
“Himanshu” in the auction sheet is the registered player **Himansu** (noted on the match).
Aniket and Aayush are marked payment **pending**; nobody else is marked paid.

## Changing the design later
* Colours / fonts / glow / card style → `css/theme.css`
* Background image → set `--stadium-bg` in `theme.css` to `url('../assets/your-image.jpg') center/cover`
* Section order on Home → `js/site-config.js`
* Player / match card layout → `js/components.js` + the matching classes in `css/style.css`
