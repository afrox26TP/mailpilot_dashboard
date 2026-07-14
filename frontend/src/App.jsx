import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Check, ChevronRight, Clock3, Eye, LayoutDashboard,
  FileSpreadsheet, Mail, Moon, Plus, RefreshCw, Send, Settings, Sun,
  Upload, UserPlus, Users, X,
} from 'lucide-react'
import { api } from './api.js'

const DEFAULT_HTML = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#17211b">
  <h1 style="font-size:32px">Dobrý den!</h1>
  <p style="font-size:17px;line-height:1.7">Sem napište obsah své nové kampaně.</p>
  <a href="https://example.com" style="display:inline-block;background:#167a4b;color:white;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Zjistit více</a>
</div>`

const initialForm = {
  listId: '', title: '', subject: '', previewText: '', fromName: '', replyTo: '',
  html: DEFAULT_HTML, testEmail: '',
}

function parseContacts(text) {
  const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean)
  return rows.flatMap((row, index) => {
    const columns = row.split(/[;,\t]/).map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
    if (index === 0 && /^(e-?mail|email_address)$/i.test(columns[0])) return []
    return [{ email: columns[0] || '', firstName: columns[1] || '', lastName: columns[2] || '' }]
  })
}

function contactCount(count) {
  if (count === 1) return '1 kontakt'
  if (count >= 2 && count <= 4) return `${count.toLocaleString('cs-CZ')} kontakty`
  return `${count.toLocaleString('cs-CZ')} kontaktů`
}

function StatusBadge({ status }) {
  const labels = {
    sent: 'Odesláno', save: 'Koncept', paused: 'Pozastaveno', sending: 'Odesílá se', schedule: 'Naplánováno',
    delivering: 'Předává se', delivered: 'Předáno serveru', canceled: 'Zrušeno', canceling: 'Ruší se',
    subscribed: 'Odebírá', unsubscribed: 'Odhlášen', pending: 'Čeká', cleaned: 'Neplatný', transactional: 'Transakční',
  }
  return <span className={`status status-${status}`}>{labels[status] || status}</span>
}

function ConfirmModal({ audience, onCancel, onConfirm, busy }) {
  const [confirmation, setConfirmation] = useState('')
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <button className="icon-button modal-close" onClick={onCancel} aria-label="Zavřít"><X size={20} /></button>
        <div className="warning-icon"><AlertTriangle size={26} /></div>
        <h2 id="confirm-title">Opravdu odeslat kampaň?</h2>
        <p>Kampaň bude okamžitě odeslána publiku <strong>{audience?.name}</strong> ({contactCount(audience?.members || 0)}). Tuto akci nelze vrátit.</p>
        <label>Pro potvrzení napište <strong>ODESLAT</strong>
          <input autoFocus value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="ODESLAT" />
        </label>
        <div className="modal-actions">
          <button className="button secondary" onClick={onCancel} disabled={busy}>Zrušit</button>
          <button className="button danger" onClick={() => onConfirm(confirmation)} disabled={confirmation !== 'ODESLAT' || busy}>
            {busy ? <RefreshCw className="spin" size={18} /> : <Send size={18} />} Odeslat všem
          </button>
        </div>
      </section>
    </div>
  )
}

export default function App() {
  const [form, setForm] = useState(initialForm)
  const [audiences, setAudiences] = useState([])
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  const [contacts, setContacts] = useState([])
  const [contactTotal, setContactTotal] = useState(0)
  const [contactText, setContactText] = useState('')
  const [consentConfirmed, setConsentConfirmed] = useState(false)
  const [contactsLoading, setContactsLoading] = useState(false)

  const audience = useMemo(() => audiences.find((item) => item.id === form.listId), [audiences, form.listId])
  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))

  const loadData = async () => {
    setLoading(true)
    setError('')
    try {
      const health = await api.health()
      setConfigured(health.configured)
      if (!health.configured) return
      const [audienceData, campaignData] = await Promise.all([api.audiences(), api.campaigns()])
      setAudiences(audienceData.audiences)
      setCampaigns(campaignData.campaigns)
      setForm((current) => ({ ...current, listId: current.listId || audienceData.audiences[0]?.id || '' }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const loadContacts = async (listId) => {
    if (!listId || !configured) return
    setContactsLoading(true)
    try {
      const result = await api.contacts(listId)
      setContacts(result.contacts)
      setContactTotal(result.total)
    } catch (err) {
      setError(err.message)
    } finally {
      setContactsLoading(false)
    }
  }

  useEffect(() => {
    if (form.listId) loadContacts(form.listId)
  }, [form.listId, configured])

  const readContactFile = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setContactText(String(reader.result || ''))
    reader.onerror = () => setError('Soubor se nepodařilo načíst.')
    reader.readAsText(file)
    event.target.value = ''
  }

  const importContacts = async () => {
    const parsed = parseContacts(contactText)
    if (!form.listId) return setError('Nejdříve vyberte publikum.')
    if (!parsed.length) return setError('Vložte alespoň jeden kontakt.')
    if (!consentConfirmed) return setError('Potvrďte, že kontakty souhlasily s odběrem.')
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.importContacts(form.listId, { contacts: parsed, consentConfirmed })
      const errorSuffix = result.errors.length ? ` ${result.errors.length} kontaktů se nepodařilo přidat.` : ''
      setNotice(`Import dokončen: ${result.created} nových kontaktů.${errorSuffix}`)
      setContactText('')
      setConsentConfirmed(false)
      await Promise.all([loadContacts(form.listId), loadData()])
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const valid = form.listId && form.title && form.subject && form.fromName && form.replyTo && form.html

  const sendTest = async () => {
    if (!valid || !form.testEmail) return setError('Vyplňte všechna povinná pole včetně testovacího e-mailu.')
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.sendTest(form)
      setNotice(`${result.message} ID kampaně: ${result.campaignId}`)
      await loadData()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const sendLive = async (confirmation) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.send({ ...form, confirmation })
      setNotice(`${result.message} ID kampaně: ${result.campaignId}`)
      setShowConfirm(false)
      setForm((current) => ({ ...initialForm, listId: current.listId, fromName: current.fromName, replyTo: current.replyTo }))
      await loadData()
    } catch (err) { setError(err.message); setShowConfirm(false) } finally { setBusy(false) }
  }

  return (
    <div className={`app-shell ${darkMode ? 'dark' : ''}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Mail size={22} /></span><span>MailPilot</span></div>
        <nav>
          <a href="#overview"><LayoutDashboard size={16} /> Kampaně</a>
          <a href="#contacts"><Users size={16} /> Kontakty</a>
          <button className="nav-button" onClick={() => setDarkMode((current) => !current)}>
            {darkMode ? <Sun size={16} /> : <Moon size={16} />} {darkMode ? 'Světlý' : 'Tmavý'}
          </button>
        </nav>
        <div className="sidebar-bottom"><span className={`connection ${configured ? '' : 'offline'}`}></span>{configured ? 'Mailchimp připojen' : 'Nastavení'}</div>
      </aside>

      <main>
        <header className="topbar">
          <div><p className="eyebrow">KAMPAŇ</p><h1>Nová e-mailová kampaň</h1></div>
          <div className="topbar-actions">
            <button className="button ghost" onClick={loadData} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Obnovit</button>
            <a className="button primary new-button" href="#composer"><Plus size={17} /> Nová</a>
          </div>
        </header>

        {!configured && <div className="alert warning"><Settings size={20} /><div><strong>Nejdříve připojte Mailchimp</strong><br />Doplňte API klíč a server prefix do souboru .env podle návodu.</div></div>}
        {error && <div className="alert error"><AlertTriangle size={20} /><span>{error}</span><button onClick={() => setError('')}><X size={17} /></button></div>}
        {notice && <div className="alert success"><Check size={20} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={17} /></button></div>}

        <section className="contacts-panel card" id="contacts">
          <div className="contacts-heading">
            <div><h2><UserPlus size={17} /> Kontakty publika</h2><p>Vložte e-maily ručně nebo nahrajte CSV. Kontakty se přidají do právě vybraného publika.</p></div>
            <strong>{contactCount(contactTotal)}</strong>
          </div>
          <div className="contacts-grid">
            <div className="contact-import">
              <div className="import-toolbar">
                <span>Formát: <b>e-mail; jméno; příjmení</b> — jeden kontakt na řádek</span>
                <label className="file-button"><FileSpreadsheet size={15} /> Nahrát CSV
                  <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={readContactFile} />
                </label>
              </div>
              <textarea
                className="contacts-input"
                value={contactText}
                onChange={(event) => setContactText(event.target.value)}
                placeholder={'jan@firma.cz; Jan; Novák\npetra@firma.cz; Petra; Svobodová'}
                spellCheck="false"
              />
              <div className="import-footer">
                <label className="consent-check">
                  <input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} />
                  Potvrzuji, že všechny kontakty výslovně souhlasily s odběrem.
                </label>
                <button className="button primary" onClick={importContacts} disabled={busy || !form.listId || !contactText.trim()}>
                  {busy ? <RefreshCw className="spin" size={16} /> : <Upload size={16} />} Importovat {parseContacts(contactText).length || ''}
                </button>
              </div>
            </div>
            <div className="contacts-list">
              <div className="contacts-list-title"><span>Poslední kontakty</span><button className="text-button" onClick={() => loadContacts(form.listId)} disabled={contactsLoading}><RefreshCw size={14} className={contactsLoading ? 'spin' : ''} /> Obnovit</button></div>
              <div className="contacts-table-wrap">
                <table className="contacts-table">
                  <thead><tr><th>E-mail</th><th>Jméno</th><th>Stav</th></tr></thead>
                  <tbody>
                    {contactsLoading ? <tr><td colSpan="3">Načítám kontakty…</td></tr> : contacts.length === 0 ? <tr><td colSpan="3">V publiku zatím nejsou žádné kontakty.</td></tr> : contacts.slice(0, 8).map((contact) => (
                      <tr key={contact.id}><td>{contact.email}</td><td>{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || '—'}</td><td><StatusBadge status={contact.status} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <div className="workspace" id="composer">
          <section className="card composer">
            <div className="section-title"><span>1</span><div><h2>Kdo a kam</h2><p>Vyberte publikum a nastavte odesílatele.</p></div></div>
            <div className="form-grid">
              <label className="full">Publikum *
                <select value={form.listId} onChange={update('listId')} disabled={loading || !configured}>
                  <option value="">Vyberte publikum</option>
                  {audiences.map((item) => <option key={item.id} value={item.id}>{item.name} — {contactCount(item.members)}</option>)}
                </select>
              </label>
              <label>Jméno odesílatele *<input value={form.fromName} onChange={update('fromName')} placeholder="Např. Jana z Acme" /></label>
              <label>E-mail pro odpovědi *<input type="email" value={form.replyTo} onChange={update('replyTo')} placeholder="jana@firma.cz" /></label>
            </div>

            <div className="divider" />
            <div className="section-title"><span>2</span><div><h2>Základ kampaně</h2><p>Tyto údaje uvidíte vy i příjemci.</p></div></div>
            <div className="form-grid">
              <label>Název kampaně *<input value={form.title} onChange={update('title')} maxLength="150" placeholder="Červencový newsletter" /></label>
              <label>Předmět e-mailu *<input value={form.subject} onChange={update('subject')} maxLength="150" placeholder="Máme pro vás novinky ✨" /></label>
              <label className="full">Náhledový text <span className="counter">{form.previewText.length}/150</span><input value={form.previewText} onChange={update('previewText')} maxLength="150" placeholder="Krátký text viditelný vedle předmětu…" /></label>
            </div>

            <div className="divider" />
            <div className="section-title"><span>3</span><div><h2>Obsah e-mailu</h2><p>Vložte validní HTML. Před odesláním použijte náhled a test.</p></div></div>
            <div className="editor-toolbar"><span>HTML editor</span><button className="text-button" onClick={() => setShowPreview(!showPreview)}><Eye size={16} /> {showPreview ? 'Upravit' : 'Náhled'}</button></div>
            {showPreview
              ? <iframe className="email-preview" title="Náhled e-mailu" sandbox="" srcDoc={form.html} />
              : <textarea className="code-editor" value={form.html} onChange={update('html')} spellCheck="false" />}
          </section>

          <aside className="right-column">
            <section className="card summary">
              <h2>Připraveno k odeslání?</h2>
              <div className="summary-row"><span><Users size={18} /> Publikum</span><strong>{audience?.name || 'Nevybráno'}</strong></div>
              <div className="summary-row"><span><Mail size={18} /> Příjemci</span><strong>{audience ? audience.members.toLocaleString('cs-CZ') : '—'}</strong></div>
              <div className="test-box">
                <label>Nejdřív poslat test<input type="email" value={form.testEmail} onChange={update('testEmail')} placeholder="vas@email.cz" /></label>
                <button className="button secondary full-button" onClick={sendTest} disabled={busy || !configured}><Send size={17} /> Odeslat test</button>
              </div>
              <button className="button primary full-button send-main" onClick={() => valid ? setShowConfirm(true) : setError('Vyplňte všechna povinná pole.')} disabled={busy || !configured}>
                <Send size={19} /> Odeslat kampaň <ChevronRight size={18} />
              </button>
              <p className="consent-note"><Check size={14} /> Pouze kontaktům se souhlasem v Mailchimpu</p>
            </section>

            <section className="card recent" id="overview">
              <div className="recent-header"><h2>Poslední kampaně</h2><Clock3 size={18} /></div>
              {loading ? <p className="muted">Načítám…</p> : campaigns.length === 0 ? <p className="muted">Zatím žádné kampaně.</p> : campaigns.slice(0, 5).map((item) => (
                <div className="campaign-item" key={item.id}><div><strong>{item.title}</strong><small>{item.subject || 'Bez předmětu'}{item.status === 'sent' ? ` · ${item.emailsSent} e-mailů` : ''}</small></div><StatusBadge status={item.deliveryStatus || item.status} /></div>
              ))}
            </section>
          </aside>
        </div>
      </main>
      {showConfirm && <ConfirmModal audience={audience} onCancel={() => setShowConfirm(false)} onConfirm={sendLive} busy={busy} />}
    </div>
  )
}
