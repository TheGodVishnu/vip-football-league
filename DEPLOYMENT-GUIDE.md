# VIP FOOTBALL LEAGUE — Upgrade & Deployment Guide

This upgrade adds: multi-admin login, Owner remote control, one shared points balance,
Played / Not played tracking and the fixed Money Converter. **Your design, data and Firebase project are unchanged.**

## 0. What you need to know first (plan / billing)

Secure username + password accounts and instant "disable this admin everywhere" cannot be done by website
code alone. They need a small server program: **Firebase Cloud Functions**. Cloud Functions need the
**Blaze (pay-as-you-go) plan**. Blaze has a free monthly allowance far bigger than a society league will ever use,
so the normal cost is ₹0, but Google asks for a card. In Firebase Console → Usage and billing you can set a
budget alert (for example ₹100) so you are told if anything ever costs money.

Your website itself stays on Cloudflare Pages (free). Only the small functions run on Firebase.

## 1. BACKUP FIRST (2 minutes, important)

1. Open the **current** admin page → **History & Backup → Download full backup**. Keep the JSON file.
2. Keep a copy of your current project folder (the old ZIP). It is your rollback.

## 2. What changes in your data (nothing is migrated or rewritten)

* **No migration script is run.** Existing records are not touched.
* Your current balances stay exactly as they are: balance = points earned in completed matches + the points ledger of the player. Same formula as before.
* Old matches have no `bonusCharged` field → their stored captain bonus is treated as *already accounted for*. It is **never deducted again**. (Tested: re-saving an old match changes nothing.)
* Only NEW bonus points (matches you create from now on, or bonus you raise in an old match) are deducted from the captain's shared balance, one ledger line each.
* Old matches have no Played/Not played marks → every purchased player counts as **Played**, exactly as before. (Tested: all 20 players' statistics are identical before and after the upgrade.)
* Old discount-table rows saved in Settings are left in the database but ignored; the fixed 250/500/1000 table is used.
* New fields are only additions, so if you ever roll back to the old files the data still works.

## 3. One-time setup of the admin service (Cloud Functions)

On your computer (Windows/Mac/Linux). You need Node.js 20 or newer: https://nodejs.org

1. Open a terminal inside the `VIP-FOOTBALL-LEAGUE` folder.
2. `npm install -g firebase-tools`
3. `firebase login` (use the Google account that owns the Firebase project)
4. In Firebase Console → **Upgrade to Blaze** (see section 0).
5. (Optional) Open `functions/.env` and change `OWNER_USERNAME=owner` to the username **you** want to type on the login page. Use lowercase letters/numbers.
6. `cd functions && npm install && cd ..`
7. Deploy the functions **and** the new Firestore rules together:

   `firebase deploy --only functions,firestore:rules`

   The first deploy may ask to enable Google APIs — answer **Y**. It can take a few minutes.

### One-time permission step (needed for sign-in tokens)

If sign-in later says *"Could not create the sign-in token"*, do this once:

1. Google Cloud Console → https://console.cloud.google.com → select project **society-football-league** → **IAM & Admin → IAM**.
2. Tick *Include Google-provided role grants*. Find the account that looks like `1089090053447-compute@developer.gserviceaccount.com` (also check `firebase-adminsdk-…`).
3. Edit (pencil) → **Add another role** → **Service Account Token Creator** → Save. Wait ~2 minutes.

### If sign-in says "Login service is not set up correctly"

Google Cloud Console → **APIs & Services → Credentials** → open the browser API key (`AIzaSyAUFh…`). Under *Application restrictions* choose **None** (or add no website restriction), under *API restrictions* make sure **Identity Toolkit API** is allowed. Save, wait 2 minutes.

## 4. Upload the website

Upload the whole folder to Cloudflare Pages exactly like before (Workers & Pages → your project → Upload new version). The `functions/` folder, `firebase.json` and `.firebaserc` are only for the Firebase CLI; uploading them to Pages is harmless.

## 5. First login as Owner

1. Open `/admin.html`. You now see **Username** and **Password** only.
2. Username = the `OWNER_USERNAME` from step 5 (default `owner`). Password = **your existing password** (your Firebase account and UID `w1oMfha7SpV6ogBMDNNGNLDplXs2` are unchanged — it is the same account).
3. Open **Manage Admins** (only you see it) → **+ New admin** → choose a username and password → give them to that person privately.

You can no longer reset *your own* password by e-mail from the login page (there is no e-mail field any more). If you forget it: Firebase Console → Authentication → Users → your user → ⋮ → **Reset password**.

## 6. Daily use

* **Disable** (Manage Admins): the admin is logged out on every device at once, cannot change any data (Firestore rules check this on every write), and cannot sign in until you press **Activate**.
* **New password**: sets a new password and ends that admin's sessions.
* **Remove**: deletes the account for good (matches/players they entered stay).
* Closing a tab or the browser does **not** sign anyone out. Only **Sign out**, or you disabling them, does.
* **Captains & budgets**: the *Bonus points* you enter are taken from the captain's shared balance (you see the balance under the captain). Not enough points → it is refused.
* **Played / Not played**: Matches & Auction → open a match → *Played / Not played* section.
* **Money Converter**: match → Fees & expenses → *Money Converter* button next to a player.

## 7. Rollback

* Website: re-upload your old project ZIP to Cloudflare Pages.
* Rules: Firebase Console → Firestore → Rules → paste the old `firestore.rules` → Publish. (Old rules only know the Owner UID, so other admins would stop working — that is expected after a rollback.)
* Data: nothing was rewritten, so nothing needs to be restored. Your JSON backup from step 1 is the safety net.

## 8. Things to decide / known limits (please read)

* A captain's bonus is deducted for the **full amount you type**, even if part of it is above the max budget (150) and therefore unusable. Type only what you want to use.
* Entry fees are unchanged: players marked *Not played* still appear in the fee list. Tell me if they should not owe the fee.
* A redemption is only offered when the discount is not bigger than the match entry fee (so points are never wasted).
* Match points a player earned stay in the balance even if you later mark them *Not played* (you decide the number in *Score & player stats*; "Fill from rules" gives 0 to Not-played players).
* Points from matches count in the balance once the match is **completed** (as before).
