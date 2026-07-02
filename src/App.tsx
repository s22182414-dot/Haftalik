import { useState, useEffect } from 'react'
import './App.css'
import './index.css'

// ─── ICONS ────────────────────────────────────────────────────────────────────
const IconActivity = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
)
const IconPlay = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
)
const IconSend = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
)

const IconLogout = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)

const IconTelegram = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
    <line x1="12" y1="18" x2="12.01" y2="18" />
  </svg>
)
const IconCheck = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)


// ─── NAVBAR ───────────────────────────────────────────────────────────────────
function Navbar() {
  return (
    <nav className="navbar">
      <div className="nav-brand">
        <span className="nav-logo">
          <IconActivity />
        </span>
        <span>Maktab tizimi – Hisobotlar</span>
      </div>
      <div className="nav-status">
        <span className="status-dot" />
        TIZIM FAOL
      </div>
    </nav>
  )
}

// ─── HOME PAGE ────────────────────────────────────────────────────────────────
type ActionStatus = { type: 'success' | 'error'; message: string } | null

function HomePage() {
  const [loading, setLoading] = useState<string | null>(null)
  const [status, setStatus] = useState<ActionStatus>(null)
  const API_BASE = ''

  // ─── USERBOT STATES ─────────────────────────────────────────────────────────
  const [userbotStatus, setUserbotStatus] = useState<{ connected: boolean; phoneNumber?: string; apiId?: string }>({ connected: false })
  const [userbotLoading, setUserbotLoading] = useState(false)
  const [userbotStep, setUserbotStep] = useState<1 | 2>(1)
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [twoFactorPassword, setTwoFactorPassword] = useState('')
  const [passwordRequired, setPasswordRequired] = useState(false)

  const showStatus = (type: 'success' | 'error', message: string) => {
    setStatus({ type, message })
    setTimeout(() => setStatus(null), 5000)
  }

  // ─── USERBOT API HANDLERS ──────────────────────────────────────────────────
  const fetchUserbotStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/userbot/status`)
      const data = await res.json()
      setUserbotStatus(data)

      // LocalStorage sync
      if (data.connected && data.session) {
        localStorage.setItem('userbotSession', JSON.stringify(data.session))
      } else if (!data.connected) {
        const stored = localStorage.getItem('userbotSession')
        if (stored) {
          try {
            const session = JSON.parse(stored)
            console.log("[USERBOT] LocalStorage dan tiklanmoqda...")
            const restoreRes = await fetch(`${API_BASE}/api/userbot/restore`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session })
            })
            const restoreData = await restoreRes.json()
            if (restoreData.success) {
              const updatedRes = await fetch(`${API_BASE}/api/userbot/status`)
              const updatedData = await updatedRes.json()
              setUserbotStatus(updatedData)
            } else if (restoreData.error === "AUTH_KEY_UNREGISTERED") {
              localStorage.removeItem('userbotSession')
            }
          } catch (e) {
            console.error(e)
          }
        }
      }
    } catch (err) {
      console.error(err)
    }
  }

  useEffect(() => {
    fetchUserbotStatus()
  }, [])

  const handleUserbotConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiId || !apiHash || !phoneNumber) {
      showStatus('error', 'Barcha maydonlarni to\'ldiring.')
      return
    }
    setUserbotLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/userbot/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiId, apiHash, phoneNumber })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        showStatus('success', data.message)
        setUserbotStep(2)
      } else {
        showStatus('error', data.error || 'Xatolik yuz berdi')
      }
    } catch {
      showStatus('error', 'Serverga ulanishda xato')
    } finally {
      setUserbotLoading(false)
    }
  }

  const handleUserbotVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!smsCode) {
      showStatus('error', 'Tasdiqlash kodini kiriting.')
      return
    }
    setUserbotLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/userbot/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: smsCode, password: twoFactorPassword })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        if (data.session) {
          localStorage.setItem('userbotSession', JSON.stringify(data.session))
        }
        showStatus('success', data.message)
        setUserbotStep(1)
        setSmsCode('')
        setTwoFactorPassword('')
        setPasswordRequired(false)
        fetchUserbotStatus()
      } else if (data.passwordRequired) {
        showStatus('success', data.message)
        setPasswordRequired(true)
      } else {
        showStatus('error', data.error || data.message || 'Kod noto\'g\'ri')
      }
    } catch {
      showStatus('error', 'Serverga ulanishda xato')
    } finally {
      setUserbotLoading(false)
    }
  }

  const handleUserbotDisconnect = async () => {
    if (!confirm('Haqiqatan ham Telegram profilingizni uzmoqchimisiz?')) return
    setUserbotLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/userbot/disconnect`, { method: 'POST' })
      const data = await res.json()
      if (res.ok && data.success) {
        localStorage.removeItem('userbotSession')
        showStatus('success', data.message)
        fetchUserbotStatus()
      } else {
        showStatus('error', data.error || 'Uzishda xatolik yuz berdi')
      }
    } catch {
      showStatus('error', 'Serverga ulanishda xato')
    } finally {
      setUserbotLoading(false)
    }
  }

  const handleTozalash = async () => {
    setLoading('juma')
    try {
      const res = await fetch(`${API_BASE}/api/tozalash`, { method: 'POST' })
      const data = await res.json() as { success?: boolean; message?: string; error?: string; missing?: Record<string, boolean> }
      if (res.ok && data.success) {
        showStatus('success', data.message || 'Muvaffaqiyatli bajarildi ✅')
      } else {
        const missing = data.missing
          ? Object.entries(data.missing).filter(([, v]) => v).map(([k]) => k).join(', ')
          : ''
        let friendlyError = data.error || 'Xato'
        if (friendlyError.includes('must not be an Office file')) {
          friendlyError = "Fayl .xlsx (Excel) formatida. Iltimos, uni Google Sheets formatiga o'tkazing (Файл -> Сохранить как Google Таблицы)."
        }
        showStatus('error', friendlyError + (missing ? `: ${missing}` : ''))
      }
    } catch {
      showStatus('error', 'Server bilan ulanishda xato')
    } finally {
      setLoading(null)
    }
  }

  const handleShanba = async () => {
    setLoading('shanba')
    try {
      const res = await fetch(`${API_BASE}/api/shanba`, { method: 'POST' })
      const data = await res.json() as { success?: boolean; message?: string; error?: string }
      if (res.ok && data.success) {
        showStatus('success', data.message || 'Yuborildi ✅')
      } else {
        showStatus('error', data.error || 'Xato yuz berdi')
      }
    } catch {
      showStatus('error', 'Server bilan ulanishda xato')
    } finally {
      setLoading(null)
    }
  }

  const handleBarcha = async () => {
    setLoading('barcha')
    try {
      const res = await fetch(`${API_BASE}/api/barcha`, { method: 'POST' })
      const data = await res.json() as { success?: boolean; message?: string; error?: string }
      if (res.ok && data.success) {
        showStatus('success', data.message || 'Yuborildi ✅')
      } else {
        showStatus('error', data.error || 'Xato yuz berdi')
      }
    } catch {
      showStatus('error', 'Server bilan ulanishda xato')
    } finally {
      setLoading(null)
    }
  }


  return (
    <main className="main">
      {/* HERO */}
      <section className="hero">
        <div className="hero-badge">
          <IconActivity />
          Avtomatik tizim
        </div>
        <h1>Haftalik hisobotlar <span>avtomatizatsiyasi</span>.</h1>
        <p className="hero-desc">
          <a href="https://drive.google.com" target="_blank" rel="noopener noreferrer">Google Drive</a> tizimidagi ma'lumotlarni yig'ish, <a href="https://gemini.google.com" target="_blank" rel="noopener noreferrer">Gemini AI</a> yordamida 16 xil
          yo'nalishda tahlil qilish va 16 varaqli Excel hisobotini <a href="https://t.me" target="_blank" rel="noopener noreferrer">Telegram</a> orqali yuborish tizimi.
        </p>

        {/* ACTION CARD */}
        <div className="action-card">
          <div className="action-card-info">
            <h3>Qo'lda ishga tushirish</h3>
            <p>Hisobot amallarini jadvaldan tashqari zudlik bilan <a href={import.meta.env.VITE_SPREADSHEET_ID} target="_blank" rel="noopener noreferrer">Google Sheets jadvaliga</a> qarab ishga tushirish.</p>
          </div>
          <div className="action-buttons">
            <button
              id="btn-juma"
              className="btn btn-dark"
              onClick={handleTozalash}
              disabled={loading === 'juma'}
            >
              <IconPlay />
              {loading === 'juma' ? 'Tozalanmoqda...' : 'Juma: Tozalash'}
            </button>
            <button
              id="btn-shanba"
              className="btn btn-green"
              onClick={handleShanba}
              disabled={loading === 'shanba'}
            >
              <IconCheck />
              {loading === 'shanba' ? 'Tekshirilmoqda...' : 'Shanba: AI Tahlil'}
            </button>
            <button
              id="btn-barcha"
              className="btn btn-blue"
              onClick={handleBarcha}
              disabled={loading === 'barcha'}
            >
              <IconSend />
              {loading === 'barcha' ? 'Yuborilmoqda...' : 'Barcha sinflar (14 ta)'}
            </button>
          </div>
        </div>

        {/* STATUS BANNER */}
        {status && (
          <div className={`status-banner ${status.type === 'success' ? 'status-success' : 'status-error'}`}>
            {status.type === 'success' ? '✅' : '❌'} {status.message}
          </div>
        )}
      </section>

      {/* INTEGRATIONS */}
      <p className="section-title">Integratsiyalar</p>
      <div className="cards-grid">



        {/* Telegram Card */}
        <div className="integration-card">
          <div className="card-header">
            <div className="card-icon card-icon-purple"><IconTelegram /></div>
            {userbotStatus.connected ? (
              <span className="card-status-badge badge-green">
                <span className="badge-dot" /><IconCheck /> Profil faol
              </span>
            ) : (
              <span className="card-status-badge badge-blue">
                <span className="badge-dot" /> Ulanmagan
              </span>
            )}
          </div>
          <div>
            <h2 className="card-title">Telegram shaxsiy profil (Userbot)</h2>
            <p className="card-desc">
              Xabarlar, Excel havolalari (preview bilan) va sinf rasmlari shaxsiy{' '}
              <a href="https://t.me" target="_blank" rel="noopener noreferrer">Telegram profilingizdan</a> guruhlarga yuboriladi. Ulanmagan bo'lsa,{' '}
              <a href={`https://t.me/bot${import.meta.env.VITE_TELEGRAM_BOT_TOKEN?.split(':')[0]}`} target="_blank" rel="noopener noreferrer">Telegram Bot orqali yuboriladi</a>.
            </p>
          </div>

          {userbotStatus.connected ? (
            <>
              <div className="info-rows" style={{ marginBottom: '8px' }}>
                <div className="info-row">
                  <span className="info-label">Ulangan raqam:</span>
                  <span className="info-value">{userbotStatus.phoneNumber}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">API ID:</span>
                  <span className="info-value">{userbotStatus.apiId}</span>
                </div>
              </div>
              <div className="card-actions">
                <button
                  id="btn-tg-disconnect"
                  className="btn btn-danger-outline"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={handleUserbotDisconnect}
                  disabled={userbotLoading}
                >
                  <IconLogout /> Profilingizni uzish (Disconnect)
                </button>
              </div>
            </>
          ) : (
            <div>
              {userbotStep === 1 ? (
                <form onSubmit={handleUserbotConnect} className="space-y-4">
                  <div className="form-alert">
                    <strong>API ID va API Hash olish uchun:</strong>
                    <ol>
                      <li><a href="https://my.telegram.org" target="_blank" rel="noreferrer">my.telegram.org</a> saytiga kiring.</li>
                      <li>Tizimga telefon raqam orqali kirib, <strong>API development tools</strong> bo'limida ilova yarating.</li>
                      <li>Ilova ma'lumotlarini (API ID va API Hash) pastga kiriting.</li>
                    </ol>
                  </div>

                  <div className="form-grid">
                    <div className="form-group">
                      <label className="form-label">API ID</label>
                      <input
                        type="text"
                        required
                        placeholder="Masalan: 34889244"
                        value={apiId}
                        onChange={e => setApiId(e.target.value)}
                        disabled={userbotLoading}
                        className="form-input"
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">API Hash</label>
                      <input
                        type="text"
                        required
                        placeholder="Masalan: ab2cd3ef..."
                        value={apiHash}
                        onChange={e => setApiHash(e.target.value)}
                        disabled={userbotLoading}
                        className="form-input"
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Telefon raqam</label>
                    <input
                      type="text"
                      required
                      placeholder="Masalan: +998911817331"
                      value={phoneNumber}
                      onChange={e => setPhoneNumber(e.target.value)}
                      disabled={userbotLoading}
                      className="form-input"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={userbotLoading}
                    className="btn btn-submit"
                  >
                    {userbotLoading ? 'Kod yuborilmoqda...' : 'Ulanish kodini olish'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleUserbotVerify} className="space-y-4">
                  <div className="form-alert" style={{ background: '#f0fdf4', color: '#14532d', borderColor: '#bbf7d0' }}>
                    Telegram orqali kelgan 5 xonali tasdiqlash kodini kiriting. Raqamingiz: <strong>{phoneNumber}</strong>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Tasdiqlash kodi</label>
                    <input
                      type="text"
                      required
                      placeholder="Masalan: 12345"
                      value={smsCode}
                      onChange={e => setSmsCode(e.target.value)}
                      disabled={userbotLoading}
                      className="form-input"
                    />
                  </div>

                  {passwordRequired && (
                    <div className="form-group">
                      <label className="form-label">2FA Parol</label>
                      <input
                        type="password"
                        placeholder="Ikki bosqichli parol"
                        value={twoFactorPassword}
                        onChange={e => setTwoFactorPassword(e.target.value)}
                        disabled={userbotLoading}
                        className="form-input"
                      />
                    </div>
                  )}

                  <div className="form-buttons-row">
                    <button
                      type="button"
                      onClick={() => { setUserbotStep(1); setSmsCode(''); setTwoFactorPassword(''); setPasswordRequired(false); }}
                      disabled={userbotLoading}
                      className="btn btn-outline"
                      style={{ flex: 1, justifyContent: 'center' }}
                    >
                      Orqaga
                    </button>
                    <button
                      type="submit"
                      disabled={userbotLoading}
                      className="btn btn-submit btn-submit-green"
                      style={{ flex: 1, justifyContent: 'center' }}
                    >
                      {userbotLoading ? 'Tasdiqlanmoqda...' : 'Ulashni yakunlash'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>

      </div>
    </main>
  )
}

// ─── APP ──────────────────────────────────────────────────────────────────────
function App() {
  return (
    <>
      <Navbar />
      <HomePage />
      <footer className="footer">
        <span className="footer-text">© 2026 Maktab tizimi</span>
        <span className="footer-text">V1.1.0 Premium</span>
      </footer>
    </>
  )
}

export default App
