import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  browserLocalPersistence,
  setPersistence,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAPDqhuyZrlDc9gcUF4WPppLgCAZfLs0fE",
  authDomain: "funder-kpi-dashboard.firebaseapp.com",
  projectId: "funder-kpi-dashboard",
  storageBucket: "funder-kpi-dashboard.firebasestorage.app",
  messagingSenderId: "427086539092",
  appId: "1:427086539092:web:2b7a522d7521f28bc140c1",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Persist the session in the browser (localStorage) so the user stays
// logged in across page reloads/visits, rather than being asked to log in
// every time -- this is fire-and-forget at module load; if it fails
// (e.g. private browsing restrictions), auth still works, sessions just
// won't survive a full page reload.
setPersistence(auth, browserLocalPersistence).catch(() => {});

export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function logout() {
  return signOut(auth);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

export function subscribeToAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}
