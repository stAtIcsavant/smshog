import { useState, useEffect } from "react";
import { createDockerDesktopClient } from "@docker/extension-api-client";

let svc = null;
try {
  svc = createDockerDesktopClient().extension.vm.service;
} catch (_) {
  // Not running inside Docker Desktop — fetch fallback used below
}

async function api(method, path, body) {
  if (svc) {
    switch (method) {
      case "GET":    return svc.get(path);
      case "POST":   return svc.post(path, body ?? {});
      case "DELETE": return svc.delete(path);
      case "PATCH":  return svc.patch(path, body ?? {});
    }
  }
  // Dev fallback
  const res = await fetch("http://localhost:9090" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(res.status);
  if (res.status === 204) return null;
  return res.json();
}

const STATUS_COLORS = {
  queued:      { bg: "#e8f0fe", text: "#1a56db" },
  sending:     { bg: "#fef3c7", text: "#b45309" },
  sent:        { bg: "#d1fae5", text: "#065f46" },
  delivered:   { bg: "#d1fae5", text: "#065f46" },
  failed:      { bg: "#fee2e2", text: "#b91c1c" },
  undelivered: { bg: "#fee2e2", text: "#b91c1c" },
  "simulated-reply": { bg: "#ede9fe", text: "#6d28d9" },
};

function Badge({ status }) {
  const c = STATUS_COLORS[status] || { bg: "#f3f4f6", text: "#374151" };
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
      background: c.bg, color: c.text, letterSpacing: "0.03em", textTransform: "uppercase",
    }}>{status}</span>
  );
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// Generates a plausible North American phone number in E.164 form.
// Area + exchange codes start at 2 (NANP rule: no 0/1 prefix); subscriber is unrestricted.
function randomPhone() {
  const area = 200 + Math.floor(Math.random() * 800);
  const exch = 200 + Math.floor(Math.random() * 800);
  const sub  = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `+1${area}${exch}${sub}`;
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [settings, setSettings] = useState({});
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("inbox");
  const [replyBody, setReplyBody] = useState("");
  const [replyUrl, setReplyUrl] = useState("");
  const [newHookUrl, setNewHookUrl] = useState("");
  const [connected, setConnected] = useState(false);

  const TEST_DEFAULTS = { to: "+15551234567", from: "+15559999999", body: "Hello from SMSHog!", callbackUrl: "" };
  const [test, setTest] = useState(TEST_DEFAULTS);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    async function init() {
      try {
        const [msgs, hooks, sett] = await Promise.all([
          api("GET", "/api/messages"),
          api("GET", "/api/webhooks"),
          api("GET", "/api/settings"),
        ]);
        setMessages(msgs);
        setWebhooks(hooks);
        setSettings(sett);
        if (sett.randomizeTestPhones) {
          setTest(t => ({ ...t, to: randomPhone(), from: randomPhone() }));
        }
        setConnected(true);
      } catch (e) {
        console.error("[smshog] init error:", e);
        setConnected(false);
      }
    }

    async function pollMessages() {
      try {
        const msgs = await api("GET", "/api/messages");
        setMessages(msgs);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }

    init();
    const id = setInterval(pollMessages, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setSelected(sel => {
      if (!sel) return sel;
      return messages.find(m => m.id === sel.id) ?? null;
    });
  }, [messages]);

  const filtered = messages.filter(m =>
    !search || m.body.toLowerCase().includes(search.toLowerCase()) ||
    m.to.includes(search) || m.from.includes(search)
  );

  async function deleteMsg(id) {
    await api("DELETE", `/api/messages/${id}`);
    setMessages(prev => prev.filter(m => m.id !== id));
    setSelected(s => s?.id === id ? null : s);
  }
  async function clearAll() {
    if (confirm("Delete all captured messages?")) {
      await api("DELETE", "/api/messages");
      setMessages([]);
      setSelected(null);
    }
  }
  async function setStatus(id, status) {
    const updated = await api("POST", `/api/messages/${id}/status`, { status });
    setMessages(prev => prev.map(m => m.id === id ? updated : m));
    setSelected(s => s?.id === id ? updated : s);
  }
  async function sendReply() {
    if (!replyBody.trim() || !selected) return;
    await api("POST", `/api/messages/${selected.id}/reply`, {
      body: replyBody,
      replyCallbackUrl: replyUrl || undefined,
    });
    setReplyBody("");
  }
  async function addWebhook() {
    if (!newHookUrl.trim()) return;
    const h = await api("POST", "/api/webhooks", { url: newHookUrl });
    setWebhooks(prev => [...prev, h]);
    setNewHookUrl("");
  }
  async function toggleWebhook(id, active) {
    const h = await api("PATCH", `/api/webhooks/${id}`, { active });
    setWebhooks(prev => prev.map(w => w.id === id ? h : w));
  }
  async function deleteWebhook(id) {
    await api("DELETE", `/api/webhooks/${id}`);
    setWebhooks(prev => prev.filter(w => w.id !== id));
  }
  async function saveSetting(key, value) {
    const s = await api("PATCH", "/api/settings", { [key]: value });
    setSettings(s);
  }
  async function sendTest() {
    if (!test.to.trim() || !test.body.trim()) {
      setTestResult({ ok: false, message: "`To` and `Body` are required" });
      return;
    }
    try {
      const msg = await api("POST", "/api/sms", {
        to: test.to, from: test.from, body: test.body,
        statusCallbackUrl: test.callbackUrl || undefined,
      });
      setTestResult({ ok: true, message: `Captured · ${msg.sid}`, id: msg.id });
      setMessages(prev => [msg, ...prev]);
    } catch (e) {
      setTestResult({ ok: false, message: String(e.message || e) });
    }
  }
  function clearTest() {
    if (settings.randomizeTestPhones) {
      setTest({ ...TEST_DEFAULTS, to: randomPhone(), from: randomPhone() });
    } else {
      setTest(TEST_DEFAULTS);
    }
    setTestResult(null);
  }
  async function testWebhook(id) {
    try {
      const res = await api("POST", `/api/webhooks/${id}/test`);
      setWebhooks(prev => prev.map(w => w.id === id ? res.hook : w));
    } catch (e) {
      console.error("[smshog] webhook test error:", e);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace", fontSize: 13, background: "var(--bg)", color: "var(--text)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--surface)", gap: 12, background: "var(--bg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "var(--success)" : "var(--danger-2)", flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.02em", color: "var(--text)" }}>SMSHog</span>
          <span style={{ fontSize: 11, color: "var(--text-muted-2)", marginLeft: 2 }}>v1.0.0</span>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{messages.length} captured</span>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--surface)", padding: "0 16px", background: "var(--bg)" }}>
        {["inbox", "test", "webhooks", "settings"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: "none", border: "none", color: tab === t ? "var(--accent)" : "var(--text-muted-2)",
            borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            padding: "8px 14px", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            fontWeight: tab === t ? 600 : 400, letterSpacing: "0.05em", textTransform: "uppercase",
          }}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {tab === "inbox" && (
          <>
            {/* Message list */}
            <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--surface)", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--surface)", display: "flex", gap: 8 }}>
                <input
                  value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search messages…"
                  style={{ flex: 1, background: "var(--surface)", border: "none", borderRadius: 6, padding: "6px 10px", color: "var(--text)", fontSize: 12, fontFamily: "inherit", outline: "none" }}
                />
                <button onClick={clearAll} title="Clear all" style={{ background: "var(--surface)", border: "none", borderRadius: 6, padding: "0 10px", cursor: "pointer", color: "var(--danger)", fontSize: 13 }}>✕</button>
              </div>
              <div style={{ flex: 1, overflowY: "auto" }}>
                {filtered.length === 0 && (
                  <div style={{ padding: 24, color: "var(--text-faint)", textAlign: "center", fontSize: 12, lineHeight: 1.8 }}>
                    No messages yet.<br />
                    Send a test SMS to<br />
                    <code style={{ color: "var(--accent)" }}>POST /api/sms</code>
                  </div>
                )}
                {filtered.map(m => (
                  <div key={m.id} onClick={() => setSelected(m)} style={{
                    padding: "10px 12px", borderBottom: "1px solid var(--surface)", cursor: "pointer",
                    background: selected?.id === m.id ? "var(--surface)" : "transparent",
                    borderLeft: selected?.id === m.id ? "3px solid var(--accent)" : "3px solid transparent",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, color: "var(--text)", fontSize: 12 }}>{m.to || "(no to)"}</span>
                      <Badge status={m.status} />
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4 }}>
                      {m.body}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-faint)" }}>{timeAgo(m.createdAt)} · {m.source}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Message detail */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto" }}>
              {!selected ? (
                <div style={{ margin: "auto", color: "var(--text-faint)", textAlign: "center" }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>📨</div>
                  <div>Select a message to inspect</div>
                </div>
              ) : (
                <div style={{ padding: 20 }}>
                  {/* Actions */}
                  <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                    {["sending", "delivered", "failed", "undelivered"].map(s => (
                      <button key={s} onClick={() => setStatus(selected.id, s)} style={{
                        background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6,
                        padding: "4px 10px", cursor: "pointer", color: "var(--text-muted)", fontSize: 11, fontFamily: "inherit",
                      }}>→ {s}</button>
                    ))}
                    <div style={{ flex: 1 }} />
                    <button onClick={() => deleteMsg(selected.id)} style={{
                      background: "none", border: "1px solid #7f1d1d", borderRadius: 6,
                      padding: "4px 10px", cursor: "pointer", color: "var(--danger)", fontSize: 11, fontFamily: "inherit",
                    }}>Delete</button>
                  </div>

                  {/* Fields */}
                  {[["SID", selected.sid], ["To", selected.to], ["From", selected.from], ["Source", selected.source]].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", marginBottom: 8, fontSize: 12 }}>
                      <span style={{ width: 60, color: "var(--text-muted-2)", flexShrink: 0 }}>{k}</span>
                      <span style={{ color: "var(--text-2)" }}>{v}</span>
                    </div>
                  ))}
                  <div style={{ marginBottom: 8, fontSize: 12 }}>
                    <span style={{ width: 60, display: "inline-block", color: "var(--text-muted-2)" }}>Status</span>
                    <Badge status={selected.status} />
                  </div>

                  {/* Body */}
                  <div style={{ background: "var(--surface)", borderRadius: 8, padding: 14, marginTop: 12, marginBottom: 12, fontSize: 13, lineHeight: 1.7, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {selected.body}
                  </div>

                  {/* Status history */}
                  <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 16 }}>
                    {selected.statusHistory?.map((h, i) => (
                      <span key={i} style={{ marginRight: 10 }}>
                        <span style={{ color: "var(--accent)" }}>{h.status}</span>
                        {" "}@ {new Date(h.at).toLocaleTimeString()}
                        {i < selected.statusHistory.length - 1 ? " →" : ""}
                      </span>
                    ))}
                  </div>

                  {/* Reply panel */}
                  <div style={{ borderTop: "1px solid var(--surface)", paddingTop: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted-2)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>Simulate reply</div>
                    <textarea
                      value={replyBody} onChange={e => setReplyBody(e.target.value)}
                      placeholder="Reply body…"
                      rows={3}
                      style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, color: "var(--text)", fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box" }}
                    />
                    <input
                      value={replyUrl} onChange={e => setReplyUrl(e.target.value)}
                      placeholder="Reply callback URL (optional)"
                      style={{ width: "100%", marginTop: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", color: "var(--text)", fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                    />
                    <button onClick={sendReply} style={{
                      marginTop: 8, background: "var(--accent-strong)", border: "none", borderRadius: 6,
                      padding: "7px 16px", cursor: "pointer", color: "#fff", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
                    }}>Send reply</button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {tab === "test" && (
          <div style={{ padding: 20, width: "100%", maxWidth: 640, overflowY: "auto" }}>
            <p style={{ color: "var(--text-muted-2)", fontSize: 12, marginTop: 0, marginBottom: 20 }}>
              Send a test SMS to the capture API. Use this to verify the inbox, delivery simulation, and webhook forwarding without leaving the UI.
            </p>

            {[
              ["To", "to", "+15551234567"],
              ["From", "from", "+15559999999"],
              ["Status callback URL", "callbackUrl", "https://your-app/twilio-callback (optional)"],
            ].map(([label, field, placeholder]) => (
              <div key={field} style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 11, color: "var(--text-muted-2)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</label>
                <input
                  value={test[field]} onChange={e => setTest(t => ({ ...t, [field]: e.target.value }))}
                  placeholder={placeholder}
                  style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", color: "var(--text)", fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                />
              </div>
            ))}

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 11, color: "var(--text-muted-2)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Body</label>
              <textarea
                value={test.body} onChange={e => setTest(t => ({ ...t, body: e.target.value }))}
                placeholder="Message body…" rows={4}
                style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, color: "var(--text)", fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box" }}
              />
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={sendTest} style={{ background: "var(--accent-strong)", border: "none", borderRadius: 6, padding: "8px 18px", cursor: "pointer", color: "#fff", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>Send test SMS</button>
              <button onClick={clearTest} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 14px", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, fontFamily: "inherit" }}>Clear inputs</button>
              {testResult && (
                <span style={{ fontSize: 12, color: testResult.ok ? "var(--success)" : "var(--danger-2)", marginLeft: 4 }}>
                  {testResult.ok ? "✓ " : "✗ "}{testResult.message}
                  {testResult.ok && testResult.id && (
                    <button onClick={() => { const m = messages.find(x => x.id === testResult.id); if (m) { setTab("inbox"); setSelected(m); } }}
                      style={{ marginLeft: 8, background: "none", border: "1px solid var(--border)", borderRadius: 5, padding: "2px 8px", cursor: "pointer", color: "var(--accent)", fontSize: 11, fontFamily: "inherit" }}>
                      View
                    </button>
                  )}
                </span>
              )}
            </div>

            <p style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 24, lineHeight: 1.7 }}>
              Tip: URLs pointing to <code style={{ color: "var(--text-muted)" }}>localhost</code> are auto-rewritten to{" "}
              <code style={{ color: "var(--text-muted)" }}>host.docker.internal</code> so the container can reach services on your machine.
            </p>
          </div>
        )}

        {tab === "webhooks" && (
          <div style={{ padding: 20, width: "100%" }}>
            <p style={{ color: "var(--text-muted-2)", fontSize: 12, marginTop: 0, marginBottom: 16 }}>
              Forward every captured SMS to these endpoints in real time. URLs to{" "}
              <code style={{ color: "var(--text-muted)" }}>localhost</code> are auto-rewritten to{" "}
              <code style={{ color: "var(--text-muted)" }}>host.docker.internal</code>.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <input
                value={newHookUrl} onChange={e => setNewHookUrl(e.target.value)}
                placeholder="http://localhost:8080/sms-hook"
                style={{ flex: 1, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", color: "var(--text)", fontSize: 12, fontFamily: "inherit", outline: "none" }}
              />
              <button onClick={addWebhook} style={{ background: "var(--accent-strong)", border: "none", borderRadius: 6, padding: "7px 16px", cursor: "pointer", color: "#fff", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>Add</button>
            </div>
            {webhooks.length === 0 && <div style={{ color: "var(--text-faint)", fontSize: 12 }}>No webhooks configured.</div>}
            {webhooks.map(h => (
              <div key={h.id} style={{ padding: "10px 12px", background: "var(--surface)", borderRadius: 8, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: h.active ? "var(--success)" : "var(--text-faint)", flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 12, color: "var(--text-2)", wordBreak: "break-all" }}>{h.url}</span>
                  <button onClick={() => testWebhook(h.id)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 8px", cursor: "pointer", color: "var(--text-muted)", fontSize: 11, fontFamily: "inherit" }}>
                    Test
                  </button>
                  <button onClick={() => toggleWebhook(h.id, !h.active)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 8px", cursor: "pointer", color: "var(--text-muted)", fontSize: 11, fontFamily: "inherit" }}>
                    {h.active ? "Pause" : "Resume"}
                  </button>
                  <button onClick={() => deleteWebhook(h.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", fontSize: 13 }}>✕</button>
                </div>
                {h.lastAt && (
                  <div style={{ marginTop: 6, marginLeft: 18, fontSize: 11, color: h.lastStatus === "ok" ? "var(--success)" : "var(--danger-2)" }}>
                    {h.lastStatus === "ok" ? "✓" : "✗"} last delivery {timeAgo(h.lastAt)}
                    {h.lastCode ? ` · HTTP ${h.lastCode}` : ""}
                    {h.lastError ? ` · ${h.lastError}` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "settings" && (
          <div style={{ padding: 20, maxWidth: 480 }}>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13 }}>
                <span>Delivery simulation</span>
                <input type="checkbox" checked={!!settings.deliverySimEnabled}
                  onChange={e => saveSetting("deliverySimEnabled", e.target.checked)} />
              </label>
              <p style={{ color: "var(--text-muted-2)", fontSize: 11, margin: 0 }}>Automatically advance messages through queued → sending → delivered/failed.</p>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", marginBottom: 6, fontSize: 13 }}>
                Delivery delay — {settings.deliveryDelayMs}ms
              </label>
              <input type="range" min={200} max={10000} step={100}
                value={settings.deliveryDelayMs || 1500}
                onChange={e => saveSetting("deliveryDelayMs", Number(e.target.value))}
                style={{ width: "100%" }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", marginBottom: 6, fontSize: 13 }}>
                Random failure rate — {Math.round((settings.deliveryFailRate || 0) * 100)}%
              </label>
              <input type="range" min={0} max={1} step={0.01}
                value={settings.deliveryFailRate || 0}
                onChange={e => saveSetting("deliveryFailRate", Number(e.target.value))}
                style={{ width: "100%" }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13 }}>
                <span>Randomize test phone numbers</span>
                <input type="checkbox" checked={!!settings.randomizeTestPhones}
                  onChange={e => saveSetting("randomizeTestPhones", e.target.checked)} />
              </label>
              <p style={{ color: "var(--text-muted-2)", fontSize: 11, margin: 0 }}>Auto-fill the Test tab's To/From with random E.164 numbers (e.g. +1 area 200-999, exchange 200-999) on app load and when you click Clear inputs.</p>
            </div>

            <div style={{ marginTop: 24, borderTop: "1px solid var(--surface)", paddingTop: 16 }}>
              <p style={{ color: "var(--text-muted-2)", fontSize: 11, margin: 0, lineHeight: 1.8 }}>
                <strong style={{ color: "var(--text-muted)" }}>Twilio-compatible endpoint</strong><br />
                <code style={{ color: "var(--accent)" }}>POST /2010-04-01/Accounts/:sid/Messages.json</code><br />
                <br />
                <strong style={{ color: "var(--text-muted)" }}>Simple custom endpoint</strong><br />
                <code style={{ color: "var(--accent)" }}>POST /api/sms</code><br />
                Body: <code style={{ color: "#a78bfa" }}>{"{ to, from, body, statusCallbackUrl }"}</code>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
