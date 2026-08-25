import React, { useEffect, useState } from "react";
import { subscribeToAuthState, logout } from "./firebase.js";
import Login from "./Login.jsx";

export default function AuthGate({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out, object = signed in

  useEffect(() => {
    const unsubscribe = subscribeToAuthState((firebaseUser) => {
      setUser(firebaseUser || null);
    });
    return unsubscribe;
  }, []);

  if (user === undefined) {
    // Firebase is still restoring the session from local storage -- this
    // is typically near-instant, but show a minimal loading state rather
    // than flashing the login screen or the dashboard prematurely.
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#F6F7F9]">
        <p className="text-[13px] text-[#8A93A3]">Loading…</p>
      </div>
    );
  }

  if (user === null) {
    return <Login />;
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-end px-4 py-2 bg-[#1D2433] sticky top-0 z-20">
        <button
          onClick={() => logout()}
          className="text-[12px] font-medium text-[#E4E7EC] bg-white/10 border border-white/15 rounded-lg px-3 py-1 hover:bg-white/20 transition-colors"
        >
          Sign out ({user.email})
        </button>
      </div>
      {children}
    </div>
  );
}
