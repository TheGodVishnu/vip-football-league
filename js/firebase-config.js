// =====================================================================
// VIP FOOTBALL LEAGUE — Firebase connection (used by index + admin)
// Firebase JS SDK 13.3.0 loaded from the official Google CDN.
// =====================================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';

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

// The admin's Firebase UID. This is NOT a secret and NOT the security —
// the real protection is firestore.rules (only this UID may write).
// It is used by the admin page only to warn you if you log in with a different account.
export const ADMIN_UID = 'w1oMfha7SpV6ogBMDNNGNLDplXs2';
