// =====================================================================
// VIP FOOTBALL LEAGUE — Cloud Functions (server side, cannot be tampered with from a browser)
//
//   adminLogin          (public)  username + password  ->  sign-in token. Hides the internal e-mail.
//   createAdmin         (Owner)   create a new admin account
//   setAdminActive      (Owner)   disable / re-activate an admin  (also kills their live sessions)
//   removeAdmin         (Owner)   delete an admin account completely
//   resetAdminPassword  (Owner)   give an admin a new password     (also kills their live sessions)
//
// Passwords are handled ONLY by Firebase Authentication. They are never stored in Firestore
// or in the website's JavaScript.
// =====================================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();

// Mumbai — close to you. Must match FUNCTIONS_REGION in js/firebase-config.js.
setGlobalOptions({ region: 'asia-south1', maxInstances: 5 });

// The existing Owner account. Never created, replaced or deleted by this code.
const OWNER_UID = 'w1oMfha7SpV6ogBMDNNGNLDplXs2';
// The Owner types this on the login page. Change it in functions/.env (OWNER_USERNAME=...).
const OWNER_USERNAME = String(process.env.OWNER_USERNAME || 'owner').trim().toLowerCase();

// This is the PUBLIC web API key of your Firebase app (the same one already in js/firebase-config.js).
// It is not a secret. It is only used to let Firebase check a password.
const WEB_API_KEY = 'AIzaSyAUFhkCp6riyKAEdn2EwMDRQUX_AeIGpvE';

// Internal e-mail used only inside Firebase Authentication for admin accounts. Never shown anywhere.
const EMAIL_DOMAIN = 'admins.vip-football-league.app';
const emailFor = (username) => `${username}@${EMAIL_DOMAIN}`;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const cleanUsername = (v) => String(v == null ? '' : v).trim().toLowerCase();

function requireOwner(request) {
  if (!request.auth || request.auth.uid !== OWNER_UID) {
    throw new HttpsError('permission-denied', 'Only the Owner can do this.');
  }
}

async function audit(action, byUid, target) {
  try {
    await db.collection('adminAudit').add({
      ts: now(), action, by: byUid || null,
      targetUid: (target && target.uid) || null,
      targetUsername: (target && target.username) || null,
    });
  } catch (e) {
    console.error('audit failed', e);
  }
}

async function getAdminDoc(uid) {
  const snap = await db.doc(`admins/${uid}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'That admin does not exist.');
  const d = snap.data();
  if (uid === OWNER_UID || d.role === 'owner') throw new HttpsError('failed-precondition', 'The Owner account cannot be changed here.');
  return { ref: snap.ref, data: d };
}

// ---------------------------------------------------------------------
// LOGIN  (anyone may call it — it only works with a correct username + password)
// ---------------------------------------------------------------------
exports.adminLogin = onCall(async (request) => {
  const username = cleanUsername(request.data && request.data.username);
  const password = String((request.data && request.data.password) || '');
  if (!username || !password) throw new HttpsError('invalid-argument', 'Enter your username and password.');
  const wrong = () => new HttpsError('unauthenticated', 'Wrong username or password.');

  // 1) find the account by username or email
  let uid;
  let email;
  try {
    if (username.includes('@')) {
      const userByEmail = await auth.getUserByEmail(username);
      uid = userByEmail.uid;
      email = userByEmail.email;
      if (uid !== OWNER_UID) {
        const snap = await db.doc(`admins/${uid}`).get();
        if (!snap.exists) { await sleep(700); throw wrong(); }
      }
    } else {
      if (username === OWNER_USERNAME) {
        uid = OWNER_UID;
      } else {
        const q = await db.collection('admins').where('usernameLower', '==', username).limit(1).get();
        if (q.empty) { await sleep(700); throw wrong(); }
        uid = q.docs[0].id;
      }
      const user = await auth.getUser(uid);
      email = user.email;
    }
    if (!email) throw new HttpsError('failed-precondition', 'This account has no sign-in e-mail. Contact the Owner.');
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    await sleep(700);
    throw wrong();
  }

  // 2) let Firebase Authentication check the password
  const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: false }),
  });
  if (!resp.ok) {
    let code = '';
    try { code = ((await resp.json()).error || {}).message || ''; } catch (e) { /* ignore */ }
    if (/TOO_MANY_ATTEMPTS/.test(code)) throw new HttpsError('resource-exhausted', 'Too many attempts. Wait a few minutes and try again.');
    if (/USER_DISABLED/.test(code)) throw new HttpsError('permission-denied', 'This admin account is disabled. Ask the Owner to re-activate it.');
    if (/API key|API_KEY|referer|blocked/i.test(code)) {
      console.error('Web API key problem:', code);
      throw new HttpsError('internal', 'Login service is not set up correctly. Tell the Owner (see the deployment notes).');
    }
    await sleep(700);
    throw wrong();
  }

  // 3) the account must be ACTIVE
  if (uid === OWNER_UID) {
    await db.doc(`admins/${uid}`).set(
      { role: 'owner', email, username: OWNER_USERNAME, usernameLower: OWNER_USERNAME, displayName: 'Owner', active: true, lastLoginAt: now() },
      { merge: true }
    );
  } else {
    const snap = await db.doc(`admins/${uid}`).get();
    if (!snap.exists || snap.data().active !== true) {
      throw new HttpsError('permission-denied', 'This admin account is disabled. Ask the Owner to re-activate it.');
    }
    await snap.ref.update({ lastLoginAt: now() });
  }

  // 4) hand the browser a sign-in token for THAT account (same UID, so the Owner stays the Owner)
  let token;
  try {
    token = await auth.createCustomToken(uid);
  } catch (e) {
    console.error('createCustomToken failed', e);
    throw new HttpsError('internal', 'Could not create the sign-in token. The Owner must finish the one-time permission step in the deployment notes (Service Account Token Creator).');
  }
  return { token };
});

// ---------------------------------------------------------------------
// OWNER-ONLY: manage admins
// ---------------------------------------------------------------------
exports.createAdmin = onCall(async (request) => {
  requireOwner(request);
  const username = cleanUsername(request.data && request.data.username);
  const password = String((request.data && request.data.password) || '');
  const displayName = String((request.data && request.data.displayName) || '').trim().slice(0, 40) || username;

  if (!USERNAME_RE.test(username)) throw new HttpsError('invalid-argument', 'Username: 3–24 characters, lowercase letters, numbers, dot, dash or underscore (must start with a letter or number).');
  if (username === OWNER_USERNAME) throw new HttpsError('invalid-argument', 'That username is reserved for the Owner.');
  if (password.length < 8 || password.length > 64) throw new HttpsError('invalid-argument', 'Password must be 8 to 64 characters.');

  const taken = await db.collection('admins').where('usernameLower', '==', username).limit(1).get();
  if (!taken.empty) throw new HttpsError('already-exists', 'That username is already used.');

  let user;
  try {
    user = await auth.createUser({ email: emailFor(username), password, displayName, emailVerified: false, disabled: false });
  } catch (e) {
    if (e && e.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'That username is already used.');
    if (e && e.code === 'auth/invalid-password') throw new HttpsError('invalid-argument', 'Password is too weak. Use at least 8 characters.');
    console.error('createUser failed', e);
    throw new HttpsError('internal', 'Could not create the account.');
  }
  const adminEmail = emailFor(username);
  try {
    await db.doc(`admins/${user.uid}`).set({
      role: 'admin', email: adminEmail, username, usernameLower: username, displayName, active: true,
      createdAt: now(), createdBy: request.auth.uid, lastLoginAt: null,
    });
  } catch (e) {
    await auth.deleteUser(user.uid).catch(() => {});
    console.error('admin doc failed', e);
    throw new HttpsError('internal', 'Could not save the admin record. Nothing was created.');
  }
  await audit('create', request.auth.uid, { uid: user.uid, username });
  return { ok: true, uid: user.uid };
});

exports.setAdminActive = onCall(async (request) => {
  requireOwner(request);
  const uid = String((request.data && request.data.uid) || '');
  const active = !!(request.data && request.data.active);
  if (!uid) throw new HttpsError('invalid-argument', 'Missing admin.');
  const { ref, data } = await getAdminDoc(uid);

  if (!active) {
    // Database flag FIRST: Firestore rules read it live, so every write from that admin is refused immediately.
    await ref.update({ active: false, disabledAt: now(), disabledBy: request.auth.uid });
    // Then the Authentication account: no new logins, and existing sign-ins can no longer refresh.
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
  } else {
    await auth.updateUser(uid, { disabled: false });
    await ref.update({ active: true, reactivatedAt: now(), reactivatedBy: request.auth.uid });
  }
  await audit(active ? 'activate' : 'disable', request.auth.uid, { uid, username: data.username });
  return { ok: true };
});

exports.removeAdmin = onCall(async (request) => {
  requireOwner(request);
  const uid = String((request.data && request.data.uid) || '');
  if (!uid) throw new HttpsError('invalid-argument', 'Missing admin.');
  const { ref, data } = await getAdminDoc(uid);

  await ref.update({ active: false, disabledAt: now(), disabledBy: request.auth.uid }); // locks writes at once
  try {
    await auth.revokeRefreshTokens(uid);
    await auth.deleteUser(uid);
  } catch (e) {
    if (!(e && e.code === 'auth/user-not-found')) {
      console.error('deleteUser failed', e);
      throw new HttpsError('internal', 'The admin was locked out but the account could not be fully deleted. Try again.');
    }
  }
  await ref.delete();
  await audit('remove', request.auth.uid, { uid, username: data.username });
  return { ok: true };
});

exports.resetAdminPassword = onCall(async (request) => {
  requireOwner(request);
  const uid = String((request.data && request.data.uid) || '');
  const password = String((request.data && request.data.password) || '');
  if (!uid) throw new HttpsError('invalid-argument', 'Missing admin.');
  if (password.length < 8 || password.length > 64) throw new HttpsError('invalid-argument', 'Password must be 8 to 64 characters.');
  const { data } = await getAdminDoc(uid);
  await auth.updateUser(uid, { password });
  await auth.revokeRefreshTokens(uid); // old sessions end; the admin signs in again with the new password
  await audit('reset-password', request.auth.uid, { uid, username: data.username });
  return { ok: true };
});
