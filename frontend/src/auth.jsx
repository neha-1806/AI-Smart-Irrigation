import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Sprout,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { API_BASE, UNAUTHORIZED_EVENT, getToken, request, setToken } from "./lib.js";

const USER_ID_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const PASSWORD_MIN = 6;

function friendly(error) {
  const message = error?.message || "";
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    return `Can't reach the backend at ${API_BASE.replace(/^https?:\/\//, "")}. Start it with "npm start" in the backend folder.`;
  }
  if (/\(404\)/.test(message)) {
    return "The backend is running an old version. Restart it with \"npm start\" in the backend folder.";
  }
  return message || "Something went wrong.";
}

/* ================= session state ================= */

export function useAuth() {
  const [status, setStatus] = useState(getToken() ? "loading" : "anon"); // loading | anon | authed
  const [user, setUser] = useState(null);
  const [info, setInfo] = useState({ hasUsers: true, allowSignup: true });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const finish = useCallback((result) => {
    setToken(result.token);
    setUser(result.user);
    setStatus("authed");
    setError("");
    setNotice("");
  }, []);

  const logout = useCallback((message = "") => {
    setToken("");
    setUser(null);
    setStatus("anon");
    setError("");
    setNotice(message);
  }, []);

  // Restore the session after a page reload.
  useEffect(() => {
    if (!getToken()) return undefined;
    let live = true;

    request("/api/auth/me")
      .then((result) => {
        if (!live) return;
        setUser(result.user);
        setStatus("authed");
      })
      .catch((e) => {
        if (!live) return;
        // Only drop the token when the server rejected it, not when it was unreachable.
        if (!(e instanceof TypeError)) setToken("");
        setError(e instanceof TypeError ? friendly(e) : "");
        setStatus("anon");
      });

    return () => {
      live = false;
    };
  }, []);

  // The server rejected our token (expired, password changed, account removed).
  useEffect(() => {
    const onRejected = () => {
      if (statusRef.current === "authed") logout("Your session ended. Please sign in again.");
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onRejected);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onRejected);
  }, [logout]);

  // On the sign-in page, find out whether this is a brand-new install.
  useEffect(() => {
    if (status !== "anon") return;
    request("/api/auth/status")
      .then(setInfo)
      .catch((e) => setError((current) => current || friendly(e)));
  }, [status]);

  // Pick up role changes made by an admin while this tab is open.
  useEffect(() => {
    if (status !== "authed") return undefined;
    const id = window.setInterval(() => {
      request("/api/auth/me")
        .then((result) => setUser(result.user))
        .catch(() => {});
    }, 60000);
    return () => window.clearInterval(id);
  }, [status]);

  const submit = useCallback(
    async (path, userId, password) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        finish(
          await request(path, { method: "POST", body: JSON.stringify({ userId, password }) })
        );
      } catch (e) {
        setError(friendly(e));
      } finally {
        setBusy(false);
      }
    },
    [finish]
  );

  return {
    status,
    user,
    info,
    error,
    notice,
    busy,
    isAdmin: user?.role === "admin",
    login: (userId, password) => submit("/api/auth/login", userId, password),
    register: (userId, password) => submit("/api/auth/register", userId, password),
    logout: () => logout(""),
    setError,
    replaceToken: setToken,
  };
}

/* ================= sign in / create account page ================= */

function PasswordInput({ value, onChange, label, autoComplete, id }) {
  const [shown, setShown] = useState(false);
  return (
    <label className="auth-field" htmlFor={id}>
      <span className="mono-label">{label}</span>
      <span className="auth-input">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          maxLength={128}
          required
        />
        <button
          type="button"
          className="reveal"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          {shown ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}

export function AuthPage({ auth }) {
  const { info, busy, error, notice } = auth;
  const firstRun = !info.hasUsers;
  const [mode, setMode] = useState("signin");
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");

  const signup = firstRun || mode === "signup";

  const submit = (event) => {
    event.preventDefault();
    setLocalError("");
    auth.setError("");

    if (signup) {
      if (!USER_ID_PATTERN.test(userId.trim())) {
        return setLocalError("User ID: 3-32 characters, letters, numbers, dot, dash or underscore.");
      }
      if (password.length < PASSWORD_MIN) {
        return setLocalError(`Password must be at least ${PASSWORD_MIN} characters.`);
      }
      if (password !== confirm) return setLocalError("The two passwords don't match.");
      return auth.register(userId.trim(), password);
    }

    return auth.login(userId.trim(), password);
  };

  const switchMode = (next) => {
    setMode(next);
    setLocalError("");
    auth.setError("");
    setPassword("");
    setConfirm("");
  };

  const shownError = localError || error;

  return (
    <div className="auth">
      <section className="auth-art">
        <div className="brand static">
          <span className="brand-mark">
            <Sprout size={18} />
          </span>
          <span className="brand-word">
            sprout<em>iq</em>
          </span>
        </div>

        <h1>
          Your field,
          <br />
          <em>watched over</em>.
        </h1>
        <p>
          Live soil moisture, pump control and farm advice from your ESP32, behind your own login.
        </p>

        <ul>
          <li>
            <ShieldCheck size={18} /> Only signed-in people can see the field
          </li>
          <li>
            <KeyRound size={18} /> Admins control the pump, viewers watch
          </li>
        </ul>
      </section>

      <section className="auth-card">
        {!firstRun && info.allowSignup && (
          <div className="segment" role="tablist" aria-label="Sign in or create account">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signin"}
              className={mode === "signin" ? "active" : ""}
              onClick={() => switchMode("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signup"}
              className={mode === "signup" ? "active" : ""}
              onClick={() => switchMode("signup")}
            >
              Create account
            </button>
          </div>
        )}

        <h2>{firstRun ? "Create the admin account" : signup ? "Create your account" : "Welcome back"}</h2>
        <p className="muted small">
          {firstRun
            ? "No accounts exist yet. The first account becomes the admin and can manage everyone else."
            : signup
              ? "New accounts can view the field. An admin can give you pump control."
              : "Sign in with your user ID and password."}
        </p>

        {notice && <p className="auth-notice">{notice}</p>}

        <form onSubmit={submit} noValidate>
          <label className="auth-field" htmlFor="auth-user">
            <span className="mono-label">User ID</span>
            <span className="auth-input">
              <input
                id="auth-user"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={32}
                autoFocus
                required
              />
            </span>
          </label>

          <PasswordInput
            id="auth-pass"
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete={signup ? "new-password" : "current-password"}
          />

          {signup && (
            <PasswordInput
              id="auth-confirm"
              label="Confirm password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
            />
          )}

          {shownError && (
            <p className="form-error" role="alert">
              {shownError}
            </p>
          )}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            {signup ? "Create account" : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}

export function AuthSplash() {
  return (
    <div className="auth-splash" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={26} />
      <span>Checking your session…</span>
    </div>
  );
}

/* ================= top-bar user menu ================= */

export function UserMenu({ user, onAccount, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const esc = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="farm-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <UserRound size={15} />
        <span>{user.userId}</span>
      </button>

      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <strong>{user.userId}</strong>
            <span className={`role-pill ${user.role}`}>{user.role === "admin" ? "Admin" : "Viewer"}</span>
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAccount();
            }}
          >
            {user.role === "admin" ? <Users size={16} /> : <KeyRound size={16} />}
            {user.role === "admin" ? "Account & team" : "Account"}
          </button>
          <button role="menuitem" onClick={onLogout}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/* ================= account drawer: password + team ================= */

export function AccountDrawer({ open, onClose, auth, notify }) {
  const { user, isAdmin } = auth;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [team, setTeam] = useState([]);
  const [teamError, setTeamError] = useState("");

  const loadTeam = useCallback(async () => {
    try {
      setTeam((await request("/api/auth/users")).users);
      setTeamError("");
    } catch (e) {
      setTeamError(e.message);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setCurrent("");
    setNext("");
    setError("");
    if (isAdmin) loadTeam();
  }, [open, isAdmin, loadTeam]);

  const changePassword = async (event) => {
    event.preventDefault();
    if (next.length < PASSWORD_MIN) return setError(`New password must be at least ${PASSWORD_MIN} characters.`);
    setBusy(true);
    setError("");
    try {
      const result = await request("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ current, next }),
      });
      auth.replaceToken(result.token); // the old token was revoked by the server
      setCurrent("");
      setNext("");
      notify("ok", "Password changed. Other devices were signed out.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const setRole = async (target, role) => {
    try {
      await request(`/api/auth/users/${encodeURIComponent(target.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      notify("ok", `${target.userId} is now ${role === "admin" ? "an admin" : "a viewer"}.`);
    } catch (e) {
      notify("error", e.message);
    }
    loadTeam();
  };

  const remove = async (target) => {
    if (!window.confirm(`Delete ${target.userId}? They will be signed out and lose access.`)) return;
    try {
      await request(`/api/auth/users/${encodeURIComponent(target.userId)}`, { method: "DELETE" });
      notify("ok", `${target.userId} was removed.`);
    } catch (e) {
      notify("error", e.message);
    }
    loadTeam();
  };

  return (
    <>
      <div className={`scrim ${open ? "show" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <header>
          <div>
            <span className="mono-label">Account</span>
            <h3>{user?.userId}</h3>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <p className="muted small account-role">
          <span className={`role-pill ${user?.role}`}>{user?.role === "admin" ? "Admin" : "Viewer"}</span>
          {user?.role === "admin"
            ? "You can control the pump, edit the farm profile and manage people."
            : "You can watch the field and use the assistant. Ask an admin for pump control."}
        </p>

        <form onSubmit={changePassword}>
          <span className="mono-label">Change password</span>
          <label>
            <span className="muted small">Current password</span>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            <span className="muted small">New password</span>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              required
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            Update password
          </button>
        </form>

        {isAdmin && (
          <section className="team">
            <span className="mono-label">
              <Users size={14} /> Team
            </span>
            {teamError && <p className="form-error">{teamError}</p>}
            <ul>
              {team.map((member) => {
                const self = member.userId.toLowerCase() === user.userId.toLowerCase();
                return (
                  <li key={member.userId}>
                    <div>
                      <strong>{member.userId}</strong>
                      {self && <small className="muted"> (you)</small>}
                    </div>
                    <select
                      value={member.role}
                      onChange={(e) => setRole(member, e.target.value)}
                      aria-label={`Role for ${member.userId}`}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      className="icon"
                      onClick={() => remove(member)}
                      disabled={self}
                      aria-label={`Delete ${member.userId}`}
                      title={self ? "You can't delete yourself" : "Delete user"}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </aside>
    </>
  );
}
