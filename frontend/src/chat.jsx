import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  Copy,
  CircleAlert,
  Droplets,
  FlaskConical,
  Gauge,
  PanelLeft,
  RotateCcw,
  Sprout,
  Square,
  SquarePen,
  Trash2,
} from "lucide-react";
import { fmt, request } from "./lib.js";

/* ================= chat state (persisted in localStorage) ================= */

// One history per signed-in user, so people sharing a browser never see each other's chats.
const storageKey = (userId) => `sproutiq.chats.v1.${String(userId || "guest").toLowerCase()}`;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function loadChats(userId) {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(userId)) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c) => c && Array.isArray(c.messages))
      .map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m, fresh: false })) }));
  } catch {
    return [];
  }
}

export function useChat(userId) {
  const [chats, setChats] = useState(() => loadChats(userId)); // newest first
  const [activeId, setActiveId] = useState(null); // null = a brand-new chat
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => {
    try {
      const slim = chats.slice(0, 30).map((c) => ({
        ...c,
        messages: c.messages.slice(-60).map(({ fresh, ...m }) => m),
      }));
      localStorage.setItem(storageKey(userId), JSON.stringify(slim));
    } catch {
      // storage full or unavailable: chat still works for this session
    }
  }, [chats, userId]);

  const active = useMemo(() => chats.find((c) => c.id === activeId) || null, [chats, activeId]);
  const streaming = Boolean(active?.messages.some((m) => m.fresh));

  const patchChat = useCallback((id, fn) => {
    setChats((list) => list.map((c) => (c.id === id ? fn(c) : c)));
  }, []);

  const run = useCallback(
    async (chatId, question, history) => {
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await request("/api/chat", {
          method: "POST",
          body: JSON.stringify({ question, history: history.slice(-10) }),
          signal: controller.signal,
        });
        const text = (result.answer || "").trim() || "I couldn’t generate an answer this time.";
        patchChat(chatId, (c) => ({
          ...c,
          updatedAt: Date.now(),
          messages: [...c.messages, { id: uid(), role: "assistant", text, fresh: true }],
        }));
      } catch (error) {
        if (error.name === "AbortError") return;
        patchChat(chatId, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            { id: uid(), role: "assistant", error: true, text: error.message, retry: question },
          ],
        }));
      } finally {
        setBusy(false);
      }
    },
    [patchChat]
  );

  const send = useCallback(
    (text) => {
      const question = text.trim();
      if (!question || busy) return;
      const userMessage = { id: uid(), role: "user", text: question };

      if (active) {
        const history = active.messages
          .filter((m) => !m.error)
          .map((m) => ({ role: m.role, text: m.text }));
        patchChat(active.id, (c) => ({
          ...c,
          updatedAt: Date.now(),
          messages: [...c.messages.map((m) => ({ ...m, fresh: false })), userMessage],
        }));
        run(active.id, question, history);
      } else {
        const id = uid();
        setChats((list) => [
          {
            id,
            title: question.length > 48 ? `${question.slice(0, 47)}…` : question,
            updatedAt: Date.now(),
            messages: [userMessage],
          },
          ...list,
        ]);
        setActiveId(id);
        run(id, question, []);
      }
    },
    [active, busy, patchChat, run]
  );

  const regenerate = useCallback(() => {
    if (!active || busy) return;
    const lastUser = [...active.messages].map((m) => m.role).lastIndexOf("user");
    if (lastUser < 0) return;
    const kept = active.messages.slice(0, lastUser + 1).map((m) => ({ ...m, fresh: false }));
    const question = kept[lastUser].text;
    const history = kept
      .slice(0, lastUser)
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, text: m.text }));
    patchChat(active.id, (c) => ({ ...c, messages: kept }));
    run(active.id, question, history);
  }, [active, busy, patchChat, run]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (activeId) {
      patchChat(activeId, (c) => ({ ...c, messages: c.messages.map((m) => ({ ...m, fresh: false })) }));
    }
  }, [activeId, patchChat]);

  const finish = useCallback(
    (messageId) => {
      if (!activeId) return;
      patchChat(activeId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === messageId ? { ...m, fresh: false } : m)),
      }));
    },
    [activeId, patchChat]
  );

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
    setActiveId(null);
  }, []);

  const select = useCallback((id) => {
    abortRef.current?.abort();
    setBusy(false);
    setActiveId(id);
  }, []);

  const remove = useCallback(
    (id) => {
      setChats((list) => list.filter((c) => c.id !== id));
      if (id === activeId) {
        abortRef.current?.abort();
        setBusy(false);
        setActiveId(null);
      }
    },
    [activeId]
  );

  return { chats, active, activeId, busy, streaming, send, regenerate, stop, finish, newChat, select, remove };
}

/* ================= pieces ================= */

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const STARTERS = [
  { icon: Droplets, text: "When should I irrigate?", sub: "Using today’s soil and weather readings" },
  { icon: Gauge, text: "Explain my sensor readings", sub: "What each number means for my crop" },
  { icon: FlaskConical, text: "Is my water pH okay?", sub: "And what to do if it isn’t" },
  { icon: Sprout, text: "How does soil type affect watering?", sub: "Clay, loam, sand and in-between" },
];

function Composer({ onSend, busy, onStop, autoFocus, placeholder }) {
  const [value, setValue] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue("");
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        maxLength={4000}
        placeholder={placeholder}
        aria-label="Message the field assistant"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-row">
        <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
        {busy ? (
          <button className="send" onClick={onStop} aria-label="Stop generating">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!value.trim()} aria-label="Send message">
            <ArrowUp size={19} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}

// Reveals the answer progressively (the backend replies in one piece).
function Answer({ text, animate, onDone, onTick }) {
  const [shown, setShown] = useState(animate ? 0 : text.length);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!animate) {
      setShown(text.length);
      return undefined;
    }
    let raf;
    let progress = 0;
    let last = performance.now();
    const step = (now) => {
      progress = Math.min(text.length, progress + (now - last) * 0.9);
      last = now;
      setShown(Math.floor(progress));
      if (progress < text.length) raf = requestAnimationFrame(step);
      else doneRef.current?.();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [animate, text]);

  useEffect(() => {
    onTick?.();
  }, [shown, onTick]);

  const typing = animate && shown < text.length;

  return (
    <div className={`md ${typing ? "caret" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text.slice(0, shown)}
      </ReactMarkdown>
    </div>
  );
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        } catch {
          // clipboard blocked: nothing to do
        }
      }}
      aria-label="Copy answer"
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function Message({ m, isLast, chat, onTick }) {
  if (m.role === "user") return <div className="msg-user">{m.text}</div>;

  if (m.error) {
    return (
      <div className="msg-ai">
        <span className="ai-avatar">
          <Sprout size={16} />
        </span>
        <div className="msg-error" role="alert">
          <CircleAlert size={18} />
          <span>{m.text}</span>
          {m.retry && isLast && (
            <button onClick={chat.regenerate} disabled={chat.busy}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="msg-ai">
      <span className="ai-avatar">
        <Sprout size={16} />
      </span>
      <div className="ai-body">
        <Answer text={m.text} animate={Boolean(m.fresh)} onDone={() => chat.finish(m.id)} onTick={onTick} />
        {!m.fresh && (
          <div className="msg-actions">
            <CopyButton text={m.text} />
            {isLast && (
              <button onClick={chat.regenerate} disabled={chat.busy}>
                <RotateCcw size={15} /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Sidebar({ chat, open, onClose }) {
  return (
    <aside className={`chat-side ${open ? "open" : ""}`} aria-label="Conversations">
      <button
        className="new-chat"
        onClick={() => {
          chat.newChat();
          onClose();
        }}
      >
        <span className="badge">
          <SquarePen size={14} />
        </span>
        New chat
      </button>

      <span className="mono-label side-label">Recents</span>
      {chat.chats.length === 0 ? (
        <p className="side-empty">Your conversations will show up here. They stay on this device.</p>
      ) : (
        <ul className="chat-list">
          {chat.chats.map((c) => (
            <li key={c.id} className={`chat-item ${c.id === chat.activeId ? "active" : ""}`}>
              <button
                className="open"
                title={c.title}
                onClick={() => {
                  chat.select(c.id);
                  onClose();
                }}
              >
                {c.title}
              </button>
              <button className="del" onClick={() => chat.remove(c.id)} aria-label={`Delete “${c.title}”`}>
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/* ================= page ================= */

export function AssistantPage({ chat, reading, online, profile }) {
  const [sideOpen, setSideOpen] = useState(false);
  const scrollRef = useRef(null);
  const stick = useRef(true);

  const messages = chat.active?.messages || [];
  const empty = messages.length === 0;
  const busy = chat.busy || chat.streaming;

  const scrollDown = useCallback(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  // new message or switched chat -> jump to the bottom
  useEffect(() => {
    stick.current = true;
    scrollDown();
  }, [chat.activeId, messages.length, chat.busy, scrollDown]);

  const lastIdx = messages.length - 1;

  const context = reading ? (
    <span className="context-chip">
      <b>Knows your field</b>
      {profile.crop ? <span>{profile.crop}</span> : null}
      <span>{profile.city}</span>
      <span>soil {fmt(reading.soilPct)}%</span>
      <span>pump {reading.pump ? "on" : "off"}</span>
      {!online && <span>(last reading, ESP32 offline)</span>}
    </span>
  ) : (
    <span className="context-chip">No live field data yet — answers will be general</span>
  );

  return (
    <div className="assistant-app rise">
      <Sidebar chat={chat} open={sideOpen} onClose={() => setSideOpen(false)} />
      <div className={`side-scrim ${sideOpen ? "show" : ""}`} onClick={() => setSideOpen(false)} />

      <section className="chat-main">
        <header className="chat-head">
          <button className="icon menu-btn" onClick={() => setSideOpen(true)} aria-label="Open conversations">
            <PanelLeft size={18} />
          </button>
          <h2>{chat.active?.title || "New chat"}</h2>
        </header>

        {empty ? (
          <div className="chat-empty">
            <span className="empty-mark">
              <Sprout size={26} />
            </span>
            <h1>
              {greeting()}. What’s on your <em>field’s</em> mind?
            </h1>
            {context}
            <div className="composer-wrap" style={{ width: "min(100%, 720px)" }}>
              <Composer
                onSend={chat.send}
                busy={busy}
                onStop={chat.stop}
                autoFocus
                placeholder="Ask about irrigation, soil, crops or your sensor readings…"
              />
            </div>
            <div className="starters">
              {STARTERS.map(({ icon: Icon, text, sub }) => (
                <button key={text} onClick={() => chat.send(text)}>
                  <Icon size={18} />
                  <span>
                    {text}
                    <small>{sub}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
              <div className="chat-col">
                {messages.map((m, i) => (
                  <Message key={m.id} m={m} isLast={i === lastIdx} chat={chat} onTick={scrollDown} />
                ))}
                {chat.busy && (
                  <div className="msg-ai">
                    <span className="ai-avatar thinking">
                      <Sprout size={16} />
                    </span>
                    <div className="ai-body">
                      <span className="typing" aria-label="Assistant is thinking">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="dock">
              <Composer
                key={chat.activeId}
                onSend={chat.send}
                busy={busy}
                onStop={chat.stop}
                autoFocus
                placeholder="Reply to the assistant…"
              />
              <p className="disclaimer">
                AI can make mistakes. Check important crop, disease and pesticide decisions with a local expert.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
