// =====================================================================
// VIP FOOTBALL LEAGUE — Firebase connection (used by index + admin)
// Firebase JS SDK 13.3.0 loaded from the official Google CDN.
// =====================================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAUFhkCp6riyKAEdn2EwMDRQUX_AeIGpvE',
  authDomain: 'society-football-league.firebaseapp.com',
  projectId: 'society-football-league',
  storageBucket: 'society-football-league.firebasestorage.app',
  messagingSenderId: '1089090053447',
  appId: '1:1089090053447:web:c797449626ea3313045862',
  measurementId: 'G-4BZKN135N4',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
// Cloud Functions (admin accounts live there). Region must match functions/index.js.
export const FUNCTIONS_REGION = 'asia-south1';
export const functions = getFunctions(app, FUNCTIONS_REGION);

// The OWNER's Firebase UID. This is NOT a secret and NOT the security —
// the real protection is firestore.rules + the Cloud Functions (only this UID is the Owner).
// The admin page uses it only to decide whether to show the Owner-only "Manage Admins" section.
export const OWNER_UID = 'w1oMfha7SpV6ogBMDNNGNLDplXs2';
export const ADMIN_UID = OWNER_UID; // old name kept so nothing else breaks
