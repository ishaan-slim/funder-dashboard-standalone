import React, { useState } from "react";
import { login, resetPassword } from "./firebase.js";

// Firebase auth error codes -> friendly messages. Firebase's raw error
// messages ("Firebase: Error (auth/wrong-password).") aren't fit for
// end users, so we translate the common ones and fall back to a generic
// message for anything unexpected.
function friendlyAuthError(err) {
  const code = err && err.code;
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact an admin.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network error — check your connection and try again.";
    default:
      return "Something went wrong signing in. Please try again.";
  }
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState("login"); // "login" | "reset"
  const [resetSent, setResetSent] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await login(email.trim(), password);
      // onAuthStateChanged in App.jsx picks up the successful login and
      // swaps the view automatically -- nothing else to do here.
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await resetPassword(email.trim());
      setResetSent(true);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center bg-[#F6F7F9] px-4"
      style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, Helvetica, Arial, sans-serif" }}
    >
      <div className="w-full max-w-sm bg-white border border-[#E4E7EC] rounded-xl p-8" style={{ boxShadow: "0 4px 20px -6px rgba(16, 24, 40, 0.10)" }}>
        <h1 className="text-[18px] font-semibold text-[#1D2433] mb-1">Funder KPI Dashboard</h1>
        <p className="text-[13px] text-[#8A93A3] mb-6">
          {mode === "login" ? "Sign in to continue" : "Reset your password"}
        </p>

        {mode === "login" ? (
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <div>
              <label className="text-[12px] font-medium text-[#4B5563] mb-1 block">Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full text-[14px] border border-[#D8DCE3] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#1D4E89] focus:border-transparent"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label className="text-[12px] font-medium text-[#4B5563] mb-1 block">Password</label>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full text-[14px] border border-[#D8DCE3] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#1D4E89] focus:border-transparent"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="text-[12px] text-[#B3261E] bg-[#FCEAEA] border border-[#F5C6C4] rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-1 w-full text-[14px] font-semibold text-white bg-[#1D4E89] rounded-lg py-2.5 hover:bg-[#183F6E] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Signing in…" : "Sign in"}
            </button>

            <button
              type="button"
              onClick={() => { setMode("reset"); setError(null); setResetSent(false); }}
              className="text-[12px] text-[#1D4E89] hover:underline text-center mt-1"
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="flex flex-col gap-3">
            {resetSent ? (
              <div className="text-[13px] text-[#1E7A3D] bg-[#E6F4EA] border border-[#C3E6CE] rounded-lg px-3 py-3">
                If an account exists for that email, a password reset link has been sent. Check your inbox.
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[12px] font-medium text-[#4B5563] mb-1 block">Email</label>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full text-[14px] border border-[#D8DCE3] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#1D4E89] focus:border-transparent"
                    placeholder="you@company.com"
                  />
                </div>
                {error && (
                  <div className="text-[12px] text-[#B3261E] bg-[#FCEAEA] border border-[#F5C6C4] rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="mt-1 w-full text-[14px] font-semibold text-white bg-[#1D4E89] rounded-lg py-2.5 hover:bg-[#183F6E] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? "Sending…" : "Send reset link"}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => { setMode("login"); setError(null); setResetSent(false); }}
              className="text-[12px] text-[#1D4E89] hover:underline text-center mt-1"
            >
              Back to sign in
            </button>
          </form>
        )}

        <p className="text-[11px] text-[#AAB1BC] text-center mt-6">
          Access is by invitation only. Contact an admin if you need an account.
        </p>
      </div>
    </div>
  );
}
