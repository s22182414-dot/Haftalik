import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { pdfToPng } from 'pdf-to-png-converter'
import sharp from 'sharp'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const ENV_PATH = path.resolve(__dirname, '.env')

// Global crash protection for background library issues (like Telegram client updates loops)
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err)
})

// ─── Read .env ─────────────────────────────────────────────────────────────
function readEnv(): Record<string, string> {
  const result: Record<string, string> = {}

  // 1. process.env dan o'qi (Render, Vercel va boshqa hosting)
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) result[k] = v
  }

  // 2. .env faylidan o'qi va ustiga yoz (lokal dev uchun)
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    }
  }

  return result
}

function writeEnv(data: Record<string, string>) {
  fs.writeFileSync(ENV_PATH, Object.entries(data).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function sendJson(res: any, code: number, body: object) {
  res.setHeader('Content-Type', 'application/json')
  res.statusCode = code
  res.end(JSON.stringify(body))
}

function readBody(req: any): Promise<string> {
  return new Promise(resolve => {
    let b = ''
    req.on('data', (c: any) => { b += c })
    req.on('end', () => resolve(b))
  })
}

// Ustun indeksini harfga aylantirish (0-indexed: 0=A, 1=B, ...)
function colLetter(n: number): string {
  let result = ''
  let num = n + 1
  while (num > 0) {
    const rem = (num - 1) % 26
    result = String.fromCharCode(65 + rem) + result
    num = Math.floor((num - 1) / 26)
  }
  return result
}

// ─── Database & Userbot Helpers ──────────────────────────────────────────────
const DB_FILE = path.resolve(__dirname, 'database.json')

function readDB(): any {
  if (!fs.existsSync(DB_FILE)) {
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function writeDB(data: any) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

// Telegram kutubxonasining ichki update loop-i TIMEOUT xatosi chiqaradi va
// bu unhandled rejection bo'lib Vite serverini o'chirib yuboradi.
// Shu sababli bu xatolarni global ushlash kerak.
process.on('unhandledRejection', (reason: any) => {
  const msg = String(reason?.message || reason || '')
  if (
    msg === 'TIMEOUT' ||
    msg.includes('TIMEOUT') ||
    msg.includes('updates.js') ||
    msg.includes('_updateLoop')
  ) {
    // Telegram update loop xatosi — e'tibor bermasak bo'ladi
    return
  }
  // Boshqa xatolarni console-ga chiqaramiz (lekin crash qilmaydi)
  console.error('[unhandledRejection]', msg)
})

process.on('uncaughtException', (err: any) => {
  const msg = String(err?.message || err || '')
  if (msg === 'TIMEOUT' || msg.includes('TIMEOUT')) {
    return
  }
  console.error('[uncaughtException]', msg)
})

let tempTelegramClient: any = null
let tempPhoneNumber = ""
let tempPhoneCodeHash = ""
let tempApiId = 0
let tempApiHash = ""

async function getUserbotClient() {
  try {
    const db = readDB()
    if (db.userbotSession && db.userbotSession.sessionStr) {
      const session = new StringSession(db.userbotSession.sessionStr)
      const client = new TelegramClient(session, parseInt(db.userbotSession.apiId), db.userbotSession.apiHash, {
        connectionRetries: 3,
        autoReconnect: false,
      })
      return client
    }
  } catch (e: any) {
    console.error("[USERBOT] Client yaratishda xatolik:", e.message)
  }
  return null
}

async function connectUserbot(client: any) {
  try {
    // Telegram update loop-ini o'chirib qo'yamiz — aks holda TIMEOUT xatosi
    // serverini o'chirib yuboradi (unhandled rejection)
    if (client.updates && typeof client.updates._updateLoop === 'function') {
      client.updates._updateLoop = async () => {}
    }
    if (typeof client._updateLoop === 'function') {
      client._updateLoop = async () => {}
    }
    await client.connect()
    await client.getDialogs({ limit: 1 })
  } catch (e: any) {
    console.warn("[USERBOT] Ulanish yoki dialoglarni yuklashda xatolik:", e.message)
    await handleUserbotError(e)
    throw e
  }
}

async function handleUserbotError(error: any) {
  const errMsg = String(error.message || error)
  if (
    errMsg.includes("AUTH_KEY_UNREGISTERED") ||
    errMsg.includes("USER_DEACTIVATED") ||
    errMsg.includes("SESSION_REVOKED") ||
    errMsg.includes("SESSION_EXPIRED")
  ) {
    console.warn("[USERBOT] Sessiya yaroqsiz bo'lgani uchun tozalab yuborilmoqda...")
    try {
      const db = readDB()
      delete db.userbotSession
      writeDB(db)
    } catch (e: any) {
      console.error("[USERBOT] Sessiyani tozalashda xatolik:", e.message)
    }
  }
}

// Fan nomidan qavs ichidagi qo'shimchalarni olib tashlash: "Ona tili (50)" → "Ona tili"
function cleanSubjectName(name: string): string {
  return name.replace(/\s*\(.*?\)\s*/g, '').trim()
}

// ─── Tozalash action ───────────────────────────────────────────────────────
async function handleTozalash(res: any) {
  const env = readEnv()
  const originalSpreadsheetUrl = (env['VITE_SPREADSHEET_ID'] || '').trim()
  let spreadsheetId = originalSpreadsheetUrl
  const botToken = (env['VITE_TELEGRAM_BOT_TOKEN'] || '').trim()
  const groupId = (env['VITE_TELEGRAM_GROUP_ID'] || '').trim()
  const serviceEmail = (env['GOOGLE_SERVICE_EMAIL'] || '').trim()
  const privateKey = (env['GOOGLE_PRIVATE_KEY'] || '').replace(/\\n/g, '\n').trim()

  const spreadsheetUrl = originalSpreadsheetUrl.startsWith('http')
    ? originalSpreadsheetUrl
    : `https://docs.google.com/spreadsheets/d/${originalSpreadsheetUrl}/edit`

  // URL bo'lsa, faqat ID ni ajratib olish
  if (spreadsheetId.includes('docs.google.com/spreadsheets')) {
    const match = spreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
    if (match && match[1]) {
      spreadsheetId = match[1]
    }
  }

  if (!spreadsheetId || !botToken || !groupId || !serviceEmail || !privateKey) {
    sendJson(res, 400, {
      error: 'Sozlamalar to\'liq emas',
      missing: {
        spreadsheetId: !spreadsheetId,
        botToken: !botToken,
        groupId: !groupId,
        serviceEmail: !serviceEmail,
        privateKey: !privateKey,
      }
    })
    return
  }

  try {
    const { google } = await import('googleapis')

    // Faqat Sheets API kerak (Drive emas)
    const auth = new google.auth.JWT({
      email: serviceEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })

    const sheets = google.sheets({ version: 'v4', auth })

    // 1. Faqat sheet nomlarini olamiz (xotira tejash)
    const spreadsheetMeta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    })

    const clearRanges: string[] = []

    for (const sheet of spreadsheetMeta.data.sheets || []) {
      const sheetTitle = sheet.properties?.title || ''
      if (!sheetTitle) continue

      // Har bir sheet uchun alohida, minimal field mask bilan data olish
      const sheetDataRes = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${sheetTitle}'!A1:Z500`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values(effectiveValue.numberValue,userEnteredValue.formulaValue)',
      })
      const rows = sheetDataRes.data.sheets?.[0]?.data?.[0]?.rowData || []

      // ── O'quvchi ma'lumotlari boshlanadigan qatorni topish ──────────────
      // A ustunida 1 bo'lgan birinchi qator = birinchi o'quvchi qatori
      let studentStartIdx = -1
      for (let i = 0; i < rows.length; i++) {
        const cellA = rows[i]?.values?.[0]?.effectiveValue?.numberValue
        if (cellA === 1) {
          studentStartIdx = i
          break
        }
      }

      if (studentStartIdx === -1) continue // Bu sheetda o'quvchi yo'q

      // ── Oxirgi o'quvchi qatorini topish ─────────────────────────────────
      let studentEndIdx = studentStartIdx
      for (let i = studentStartIdx; i < rows.length; i++) {
        const cellA = rows[i]?.values?.[0]?.effectiveValue?.numberValue
        if (typeof cellA === 'number' && cellA > 0) {
          studentEndIdx = i
        }
      }

      const startRow = studentStartIdx + 1 // Google Sheets 1-indexed
      const endRow = studentEndIdx + 1

      // ── Formula ustunlarini aniqlash ─────────────────────────────────────
      const firstStudentRow = rows[studentStartIdx]
      const formulaCols = new Set<number>()
      const maxCol = firstStudentRow?.values?.length || 0

      for (let col = 3; col < maxCol; col++) {
        const cell = firstStudentRow?.values?.[col]
        if (cell?.userEnteredValue?.formulaValue) {
          formulaCols.add(col)
        }
      }

      // ── Tozalanadigan range larni qurish ─────────────────────────────────
      let rangeStart = -1
      for (let col = 3; col <= maxCol; col++) {
        const isFormula = formulaCols.has(col)
        const isPastEnd = col === maxCol

        if (!isPastEnd && !isFormula) {
          if (rangeStart === -1) rangeStart = col
        } else {
          if (rangeStart !== -1) {
            const endCol = col - 1
            clearRanges.push(
              `${sheetTitle}!${colLetter(rangeStart)}${startRow}:${colLetter(endCol)}${endRow}`
            )
            rangeStart = -1
          }
        }
      }
    }


    // 2. Faqat baho katakchalarini tozalash
    //    Sarlavhalar (fan nomlari, 1-10/11-20/21-30) va formulalar SAQLANADI
    if (clearRanges.length > 0) {
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: clearRanges },
      })
    }

    // 3. Telegramga xabar yuborish (Userbot yoki Bot fallback)
    let messageSent = false
    const userbot = await getUserbotClient()
    if (userbot) {
      try {
        console.log(`[USERBOT] Link yuborilmoqda: ${groupId}`)
        await connectUserbot(userbot)
        await userbot.sendMessage(groupId, { message: spreadsheetUrl })
        messageSent = true
      } catch (err: any) {
        console.error(`[USERBOT] Xabar yuborishda xato: ${err.message}. Bot orqali yuboriladi...`)
        await handleUserbotError(err)
      } finally {
        try {
          await userbot.disconnect()
        } catch {}
      }
    }

    if (!messageSent) {
      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: groupId,
          text: spreadsheetUrl,
        }),
      })

      const tgData = await tgRes.json() as { ok: boolean; description?: string }
      if (!tgData.ok) {
        sendJson(res, 500, { error: 'Telegram xato', details: tgData.description })
        return
      }
    }

    sendJson(res, 200, { success: true, message: 'Baholar tozalandi va havola guruhga yuborildi ✅' })
  } catch (err: any) {
    console.error('Tozalash error:', err)
    sendJson(res, 500, { error: err?.message || 'Noma\'lum xato' })
  }
}

// ─── Shanba: eng yuqori foizli o'quvchilar ────────────────────────────────
async function handleShanba(res: any) {
  const env = readEnv()
  const originalSpreadsheetUrl = (env['VITE_SPREADSHEET_ID'] || '').trim()
  let spreadsheetId = originalSpreadsheetUrl
  const botToken = (env['VITE_TELEGRAM_BOT_TOKEN'] || '').trim()
  const groupId2 = (env['VITE_TELEGRAM_GROUP_ID_2'] || '').trim()
  const serviceEmail = (env['GOOGLE_SERVICE_EMAIL'] || '').trim()
  const privateKey = (env['GOOGLE_PRIVATE_KEY'] || '').replace(/\\n/g, '\n').trim()

  if (spreadsheetId.includes('docs.google.com/spreadsheets')) {
    const match = spreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
    if (match && match[1]) spreadsheetId = match[1]
  }

  if (!spreadsheetId || !botToken || !groupId2 || !serviceEmail || !privateKey) {
    sendJson(res, 400, {
      error: groupId2 ? 'Sozlamalar to\'liq emas' : 'VITE_TELEGRAM_GROUP_ID_2 bo\'sh — .env ga ikkinchi guruh ID sini kiriting',
      missing: { spreadsheetId: !spreadsheetId, botToken: !botToken, groupId2: !groupId2, serviceEmail: !serviceEmail, privateKey: !privateKey }
    })
    return
  }

  try {
    const { google } = await import('googleapis')

    const auth = new google.auth.JWT({
      email: serviceEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })

    const sheets = google.sheets({ version: 'v4', auth })

    // 1. Faqat sheet nomlarini olamiz (includeGridData yo'q — xotira tejaydi)
    const spreadsheetMeta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(title,sheetId)',
    })

    const sheetNames = (spreadsheetMeta.data.sheets || [])
      .map(s => s.properties?.title || '')
      .filter(Boolean)

    const results: string[] = []

    // 2. Har bir sheetni alohida, faqat kerakli ustunlar
    for (const sheetTitle of sheetNames) {
      // A:Z oralig'idagi qiymatlarni o'qiymiz (formatlash yo'q)
      const valRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetTitle}'!A1:Z500`,
        valueRenderOption: 'FORMATTED_VALUE',
      })

      const rows: string[][] = (valRes.data.values || []) as string[][]
      if (rows.length === 0) continue

      // O'quvchi qatorlarini topish (A ustunida raqam bor)
      let studentStartIdx = -1
      for (let i = 0; i < rows.length; i++) {
        const aVal = Number(rows[i]?.[0])
        if (!isNaN(aVal) && aVal === 1) {
          studentStartIdx = i
          break
        }
      }
      if (studentStartIdx === -1) continue

      // Header qatorlardan "Umumiy %" ustun indeksini topish
      let umumiyColIdx = -1
      for (let hRow = 0; hRow < studentStartIdx; hRow++) {
        const headerCells = rows[hRow] || []
        for (let col = 3; col < headerCells.length; col++) {
          const cellText = (headerCells[col] || '').toLowerCase().replace(/\s/g, '')
          if (cellText.includes('umumiy') || cellText.includes('умумий')) {
            umumiyColIdx = col
          }
        }
      }

      // Fallback: oxirgi to'liq ustun
      if (umumiyColIdx === -1) {
        const sampleRow = rows[studentStartIdx] || []
        for (let col = sampleRow.length - 1; col >= 3; col--) {
          if (sampleRow[col] !== undefined && sampleRow[col] !== '') {
            umumiyColIdx = col
            break
          }
        }
      }

      // Har bir o'quvchining qiymatini yig'ish
      const studentData: { fullName: string; val: number }[] = []
      for (let i = studentStartIdx; i < rows.length; i++) {
        const rowNum = Number(rows[i]?.[0])
        if (isNaN(rowNum) || rowNum <= 0) continue
        const familiya = rows[i]?.[1] || ''
        const ism = rows[i]?.[2] || ''
        const fullName = [familiya, ism].filter(Boolean).join(' ')

        if (umumiyColIdx !== -1) {
          const rawVal = rows[i]?.[umumiyColIdx] || ''
          const numVal = parseFloat(rawVal.toString().replace('%', '').replace(',', '.'))
          if (!isNaN(numVal) && numVal > 0.1) {
            studentData.push({ fullName, val: numVal })
          }
        }
      }

      if (studentData.length === 0) continue

      const maxVal = Math.max(...studentData.map(s => s.val))
      const found = studentData.filter(s => s.val === maxVal).map(s => s.fullName)

      if (found.length > 0) {
        const titleLower = sheetTitle.toLowerCase()
        const isTib = titleLower.includes('t')
        const isBlue = titleLower.includes('b') || /^\d+$/.test(sheetTitle.trim())
        const isGreen = titleLower.includes('g')
        const icon = isTib ? '📕' : isBlue ? '📘' : isGreen ? '📗' : '📋'
        results.push(`${icon} ${sheetTitle}:\n${found.map(n => `🥇 ${n}`).join('\n')}`)
      }
    }

    if (results.length === 0) {
      sendJson(res, 200, { success: true, message: 'Eng yuqori foizli o\'quvchi topilmadi' })
      return
    }

    const messageText = results.join('\n\n')

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: groupId2, text: messageText }),
    })

    const tgData = await tgRes.json() as { ok: boolean; description?: string }
    if (!tgData.ok) {
      sendJson(res, 500, { error: 'Telegram xato', details: tgData.description })
      return
    }

    sendJson(res, 200, { success: true, message: `${results.length} ta sinf natijalari Telegramga yuborildi ✅` })
  } catch (err: any) {
    console.error('Shanba error:', err)
    sendJson(res, 500, { error: err?.message || 'Noma\'lum xato' })
  }
}

// ─── Barcha sinflar: har bir sheetni rasmga aylantirib yuborish ────────────────
const CAPTION = `Assalomu alaykum, hurmatli ota-onalar va aziz o'quvchilar!

📌 Haftalik imtihon natijalari bilan tanishing.
Ushbu natijalarni tahlil qilishda quyidagilarga e'tibor qaratishingizni so'raymiz:
✨ Agar natija yuqori bo'lsa — farzandingizni albatta rag'batlantiring va maqtang! Sizning e'tirofingiz ularning keyingi imtihonlarda yanada ishonch bilan harakat qilishiga eng kuchli turtki bo'ladi.
Agar natija past bo'lsa — tanqidga shoshilmang, aksincha, farzandingiz bilan birga past natijaning sabablarini tahlil qiling. Unga darslarda yanada faol bo'lish, mavzularda tushunmagan savollarini o'qituvchidan so'rash va uyga berilgan topshiriqlarni to'liq, o'z vaqtida bajarish muvaffaqiyatning kaliti ekanligini tushuntiring. Sizning daldangiz va nazoratingiz farzandingizni ertangi g'alabalarga yetaklovchi eng asosiy kuchdir. Sababi har bir bola mehnat, izlanish va ota-onaning qo'llab-quvvatlashi orqali o'z imkoniyatlarini namoyon eta oladi.

🏫 Boborahim Mashrab nomli xususiy maktab — ta'lim va intizom istaganlar uchun`

async function handleBarcha(res: any) {
  const env = readEnv()
  const originalSpreadsheetUrl = (env['VITE_SPREADSHEET_ID'] || '').trim()
  let spreadsheetId = originalSpreadsheetUrl
  const botToken = (env['VITE_TELEGRAM_BOT_TOKEN'] || '').trim()
  const groupId3 = (env['VITE_TELEGRAM_GROUP_ID_3'] || env['VITE_TELEGRAM_GROUP_ID_2'] || '').trim()
  const serviceEmail = (env['GOOGLE_SERVICE_EMAIL'] || '').trim()
  const privateKey = (env['GOOGLE_PRIVATE_KEY'] || '').replace(/\\n/g, '\n').trim()

  if (spreadsheetId.includes('docs.google.com/spreadsheets')) {
    const match = spreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
    if (match && match[1]) spreadsheetId = match[1]
  }

  if (!spreadsheetId || !botToken || !groupId3 || !serviceEmail || !privateKey) {
    sendJson(res, 400, {
      error: groupId3 ? 'Sozlamalar to\'liq emas' : 'Telegram guruh ID bo\'sh (VITE_TELEGRAM_GROUP_ID_3 yoki VITE_TELEGRAM_GROUP_ID_2)',
    })
    return
  }

  try {
    const { google } = await import('googleapis')

    // O'qish uchun auth
    const auth = new google.auth.JWT({
      email: serviceEmail,
      key: privateKey,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    })

    // Yozish uchun auth ("Qatnashmadi" yozish)
    const authWrite = new google.auth.JWT({
      email: serviceEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })

    const sheets = google.sheets({ version: 'v4', auth })
    const sheetsWrite = google.sheets({ version: 'v4', auth: authWrite })

    // 1. Faqat sheet nomlarini olamiz (xotira tejash)
    console.log("Sheet ro'yxatini yuklash boshlanmoqda...")
    const spreadsheetMeta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    })
    const sheetList = spreadsheetMeta.data.sheets || []

    // Access token olish (authenticated PDF export uchun)
    const tokenRes = await auth.getAccessToken()
    const accessToken = tokenRes.token

    // Visible sheetlarni aniqlash (hidden bo'lmagan va o'qituvchilar varag'i bo'lmagan barcha sinf varaqlari)
    const visibleSheets = sheetList.filter(s => {
      const t = s.properties?.title || '';
      const isTeacherSheet = t.toLowerCase().includes("o'qituvchi") || t.toLowerCase().includes("o`qituvchi") || t.toLowerCase().includes("учител") || t.toLowerCase().includes("teacher");
      return !s.properties?.hidden && !isTeacherSheet;
    })

    let sentCount = 0
    const errors: string[] = []
    const teacherMap = new Map<string, string>()
    const teacherNotifications = new Map<string, Map<string, string[]>>()
    let defaultTeacherTg = (env['VITE_DEFAULT_TEACHER_USERNAME'] || '').trim()
    if (defaultTeacherTg.startsWith('https://t.me/')) defaultTeacherTg = defaultTeacherTg.replace('https://t.me/', '')
    if (defaultTeacherTg.startsWith('http://t.me/')) defaultTeacherTg = defaultTeacherTg.replace('http://t.me/', '')
    if (defaultTeacherTg.startsWith('t.me/')) defaultTeacherTg = defaultTeacherTg.replace('t.me/', '')
    defaultTeacherTg = defaultTeacherTg.replace(/\/$/, '').trim()

    // ── O'qituvchilar ro'yxatini yuklash ──────────────────────────────────────
    const teachersSpreadsheetUrl = (env['VITE_TEACHERS_SPREADSHEET_ID'] || '').trim() || originalSpreadsheetUrl
    let teachersSpreadsheetId = teachersSpreadsheetUrl
    if (teachersSpreadsheetId.includes('docs.google.com/spreadsheets')) {
      const match = teachersSpreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
      if (match && match[1]) teachersSpreadsheetId = match[1]
    }
    try {
      const teachersMeta = await sheets.spreadsheets.get({
        spreadsheetId: teachersSpreadsheetId,
        fields: 'sheets.properties',
      })
      const teachersSheetList = teachersMeta.data.sheets || []
      const teacherSheet = teachersSheetList.find(s => {
        const t = (s.properties?.title || '').toLowerCase()
        return t.includes("o'qituvchi") || t.includes("o`qituvchi") || t.includes("o'qituvchi") || t.includes("учител") || t.includes("teacher")
      })
      if (teacherSheet) {
        const teacherSheetTitle = teacherSheet.properties?.title || ''
        const teacherValRes = await sheets.spreadsheets.values.get({
          spreadsheetId: teachersSpreadsheetId,
          range: `'${teacherSheetTitle.replace(/'/g, "''")}'!A1:C200`,
          valueRenderOption: 'FORMATTED_VALUE',
        })
        const teacherRows = teacherValRes.data.values || []
        const isOldFormat = teacherRows.length > 0 && teacherRows[0].length <= 2
        if (isOldFormat) {
          for (const r of teacherRows) {
            const subject = cleanSubjectName(r[0] || '').trim().toLowerCase().replace(/\s/g, '')
            let tg = (r[1] || '').trim()
            if (tg.startsWith('https://t.me/')) tg = tg.replace('https://t.me/', '')
            if (tg.startsWith('http://t.me/')) tg = tg.replace('http://t.me/', '')
            if (tg.startsWith('t.me/')) tg = tg.replace('t.me/', '')
            tg = tg.replace(/\/$/, '').trim()
            if (subject && subject !== "fannomi" && subject !== "subjectname" && tg) teacherMap.set(subject, tg)
          }
        } else {
          for (const r of teacherRows) {
            const cls = (r[0] || '').trim().toLowerCase().replace(/\s/g, '')
            const subject = cleanSubjectName(r[1] || '').trim().toLowerCase().replace(/\s/g, '')
            let tg = (r[2] || '').trim()
            if (tg.startsWith('https://t.me/')) tg = tg.replace('https://t.me/', '')
            if (tg.startsWith('http://t.me/')) tg = tg.replace('http://t.me/', '')
            if (tg.startsWith('t.me/')) tg = tg.replace('t.me/', '')
            tg = tg.replace(/\/$/, '').trim()
            if (cls && subject && cls !== "sinf" && cls !== "class" && subject !== "fannomi" && subject !== "subjectname" && tg) {
              teacherMap.set(`${cls}_${subject}`, tg)
            }
          }
        }
        console.log(`[BARCHA] O'qituvchilar yuklandi: ${teacherMap.size} ta`)
      }
    } catch (teachErr: any) {
      console.error("[BARCHA] O'qituvchilar ro'yxatini o'qishda xatolik:", teachErr.message)
    }

    // Userbotni boshida bir marta ulab qo'yamiz va butun jarayon davomida ishlatamiz
    const userbot = await getUserbotClient()
    if (userbot) {
      try {
        console.log("[USERBOT] Boshlang'ich ulanish...")
        await connectUserbot(userbot)
      } catch (err: any) {
        console.error("[USERBOT] Boshlang'ich ulanishda xato:", err.message)
      }
    }

    for (const sheet of visibleSheets) {
      const gid = sheet.properties?.sheetId
      const title = sheet.properties?.title || `Sheet${gid}`

      // 2. Har bir sheet uchun alohida, minimal field mask bilan data olish
      const sheetDataRes = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${title}'!A1:Z500`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values(formattedValue,effectiveValue,userEnteredValue,userEnteredFormat,note)',
      })
      const rows = sheetDataRes.data.sheets?.[0]?.data?.[0]?.rowData || []

      // O'quvchi qatorida izoh (note) bor-yo'qligini aniqlash uchun yordamchi
      // Tekshiradi: 1) Google Sheets note (popup izoh), 2) katak qiymatida "izoh" so'zi
      const rowHasNote = (rowIndex: number): boolean => {
        const vals = rows[rowIndex]?.values || []
        return vals.some((cell: any) => {
          // 1. Google Sheets popup note
          if (typeof cell?.note === 'string' && cell.note.trim() !== '') return true
          // 2. Katak qiymatida "izoh" so'zi (katta-kichik harfdan qat'i nazar)
          const cellText = (cell?.formattedValue || cell?.effectiveValue?.stringValue || '').toLowerCase()
          if (cellText.includes('izoh')) return true
          return false
        })
      }

      // ── 1. "O'rtacha o'zlashtirish" qatori va "Umumiy %" ustunini qidirib topish ──────
      let ortachaRowIdx = -1
      let umumiyColIdx = -1

      for (let r = 0; r < rows.length; r++) {
        const values = rows[r]?.values || []
        for (let c = 0; c < values.length; c++) {
          const val = (values[c]?.formattedValue || '').toLowerCase().replace(/\s/g, '')

          // Judayam keng qidiruv: "ort", "o'rt", "o'rt", "o`rt", "ўрт", "сред" (ruscha)
          const isOrtacha =
            val.includes("ort") ||
            val.includes("o'rt") ||
            val.includes("o'rt") ||
            val.includes("o`rt") ||
            val.includes("ўрт") ||
            val.includes("сред")

          if (isOrtacha && r > 2) {
            ortachaRowIdx = r
          }

          // "umumiy%" yoki "umumiy" ustunini qidirish
          if (val.includes("umumiy%") || (val.includes("umumiy") && val.includes("%")) || val.includes("умумий%")) {
            umumiyColIdx = c
          }
        }
      }

      // ── 2. Diapazonni aniqlash ────────────────────────────────────────────
      let endRow = rows.length
      let endColLetter = 'Z'

      if (ortachaRowIdx !== -1) {
        endRow = ortachaRowIdx + 1 // O'rtacha o'zlashtirish qatorini HAM oladi, lekin undan pastini qirqadi
      } else {
        let maxRow = 0
        for (let r = 0; r < rows.length; r++) {
          const values = rows[r]?.values || []
          for (let c = 0; c < values.length; c++) {
            const val = values[c]?.formattedValue
            if (val !== undefined && val !== null && val.trim() !== '') {
              if (r > maxRow) maxRow = r
            }
          }
        }
        endRow = maxRow + 1
      }

      if (umumiyColIdx !== -1) {
        endColLetter = colLetter(umumiyColIdx) // Aynan "Umumiy %" ustunigacha
      } else {
        let maxCol = 0
        for (let r = 0; r < rows.length; r++) {
          const values = rows[r]?.values || []
          for (let c = 0; c < values.length; c++) {
            const val = values[c]?.formattedValue
            if (val !== undefined && val !== null && val.trim() !== '') {
              if (c > maxCol) maxCol = c
            }
          }
        }
        endColLetter = colLetter(maxCol)
      }

      const targetRange = `A1:${endColLetter}${endRow}`

      const tempUpdates: { rowIndex: number; startCol: number; endCol: number; saveStart: number; saveEnd: number; originalCells: { col: number; cellData: any }[] }[] = []

      // ── 2.5. Bahosi yo'q o'quvchilarga "Qatnashmadi" yozish ──────────────
      // O'quvchi qatorlari boshini topish (A ustunida 1 bo'lgan birinchi qator)
      let studentStartIdx = -1
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]?.values?.[0]?.effectiveValue?.numberValue === 1) {
          studentStartIdx = i
          break
        }
      }

      if (studentStartIdx !== -1) {
        // Birinchi o'quvchi qatoridagi formula ustunlarini aniqlash (D dan boshlab)
        const firstStudentRow = rows[studentStartIdx]
        const formulaCols = new Set<number>()
        const maxColCount = firstStudentRow?.values?.length || 0

        for (let col = 3; col < maxColCount; col++) {
          const cell = firstStudentRow?.values?.[col]
          if (cell?.userEnteredValue?.formulaValue) {
            formulaCols.add(col)
          }
        }

        // O'rtacha o'zlashtirish ustunini qidirib topish
        let ortachaColIdx = -1
        for (let r = 0; r < studentStartIdx; r++) {
          const values = rows[r]?.values || []
          for (let c = 3; c < values.length; c++) {
            const val = (values[c]?.formattedValue || '').toLowerCase().replace(/\s/g, '')
            if (val.includes("ortacha") || val.includes("o'rtacha") || val.includes("o`rtacha") || val.includes("ўртача") || val.includes("сред")) {
              ortachaColIdx = c
              break
            }
          }
          if (ortachaColIdx !== -1) break
        }

        const colLimit = umumiyColIdx !== -1 ? umumiyColIdx : maxColCount
        const subjectLimit = ortachaColIdx !== -1 ? ortachaColIdx : (umumiyColIdx !== -1 ? umumiyColIdx - 2 : maxColCount)

        // Baho ustunlari guruhlari (Subject blocks)
        const subjectBlocks: { start: number; end: number }[] = []
        let currentBlock: number[] = []

        for (let col = 3; col < subjectLimit; col++) {
          if (!formulaCols.has(col)) {
            currentBlock.push(col)
          } else {
            if (currentBlock.length > 0) {
              subjectBlocks.push({
                start: currentBlock[0],
                end: currentBlock[currentBlock.length - 1]
              })
              currentBlock = []
            }
          }
        }
        if (currentBlock.length > 0) {
          subjectBlocks.push({
            start: currentBlock[0],
            end: currentBlock[currentBlock.length - 1]
          })
        }

        const isBlockEmpty = (rowIndex: number, block: { start: number; end: number }) => {
          for (let col = block.start; col <= block.end; col++) {
            const cell = rows[rowIndex]?.values?.[col]
            const val = (cell?.formattedValue || cell?.effectiveValue?.stringValue || '').trim()
            if (val !== '') {
              return false
            }
          }
          return true
        }

        if (subjectBlocks.length > 0) {
          // ── O'qituvchilarga eslatma uchun bo'sh fanlarni aniqlash ────────────
          for (const block of subjectBlocks) {
            let allStudentsEmpty = true
            for (let i = studentStartIdx; i < rows.length; i++) {
              const rowNum = rows[i]?.values?.[0]?.effectiveValue?.numberValue
              if (typeof rowNum !== 'number' || rowNum <= 0) continue
              if (ortachaRowIdx !== -1 && i >= ortachaRowIdx) break
              if (!isBlockEmpty(i, block)) { allStudentsEmpty = false; break }
            }
            if (allStudentsEmpty) {
              let subjectName = ''
              for (let r = 0; r < studentStartIdx; r++) {
                const rowVals = rows[r]?.values || []
                const v = (rowVals[block.start]?.formattedValue || '').trim()
                if (v) { subjectName = v; break }
                for (let col = block.start; col <= block.end; col++) {
                  const v2 = (rowVals[col]?.formattedValue || '').trim()
                  if (v2) { subjectName = v2; break }
                }
                if (subjectName) break
              }
              if (!subjectName) subjectName = `Ustun ${block.start + 1}`
              subjectName = cleanSubjectName(subjectName)
              const normSubject = subjectName.toLowerCase().replace(/\s/g, '')
              const normClass = title.toLowerCase().replace(/\s/g, '')
              const tgId = teacherMap.get(`${normClass}_${normSubject}`) || teacherMap.get(normSubject) || defaultTeacherTg
              if (tgId) {
                if (!teacherNotifications.has(tgId)) teacherNotifications.set(tgId, new Map<string, string[]>())
                const subMap = teacherNotifications.get(tgId)!
                if (!subMap.has(subjectName)) subMap.set(subjectName, [])
                subMap.get(subjectName)!.push(title)
              } else {
                console.warn(`[BARCHA] "${subjectName}" fani uchun ${title} sinfida o'qituvchi Telegram topilmadi (VITE_DEFAULT_TEACHER_USERNAME ham bo'sh).`)
              }
            }
          }

          // ── O'quvchilarga "qatnashmadi" yozish + ustozga eslatma ─────────────
          for (let i = studentStartIdx; i < rows.length; i++) {
            const rowNum = rows[i]?.values?.[0]?.effectiveValue?.numberValue
            if (typeof rowNum !== 'number' || rowNum <= 0) continue
            if (ortachaRowIdx !== -1 && i >= ortachaRowIdx) break

            // O'quvchi ismini olish (B ustuni = index 1, C = 2)
            const studentName =
              (rows[i]?.values?.[1]?.formattedValue || rows[i]?.values?.[2]?.formattedValue || `${rowNum}-o'quvchi`).trim()

            // Agar o'quvchi qatorida izoh (note) bo'lsa — ustozga xabar yubormaylik
            const studentHasNote = rowHasNote(i)

            let allSubjectsEmpty = true
            for (const block of subjectBlocks) {
              if (!isBlockEmpty(i, block)) {
                allSubjectsEmpty = false
                break
              }
            }

            if (allSubjectsEmpty) {
              // Butunlay qatnashmagan → barcha fan bloklari uchun ustozlarga xabar
              // Asl qiymat va formatlarni saqlash (border uchun 1 ta katak kengaytirib saqlaymiz)
              const saveStart = Math.max(3, subjectBlocks[0].start - 1)
              const saveEnd = Math.min((rows[i]?.values?.length ?? colLimit) - 1, colLimit + 1)
              const origCells: { col: number; cellData: any }[] = []
              for (let col = saveStart; col <= saveEnd; col++) {
                const cell = rows[i]?.values?.[col]
                origCells.push({
                  col,
                  cellData: cell ? {
                    userEnteredValue: cell.userEnteredValue ?? null,
                    userEnteredFormat: cell.userEnteredFormat ?? null
                  } : null
                })
              }
              tempUpdates.push({
                rowIndex: i,
                startCol: subjectBlocks[0].start,
                endCol: colLimit,
                saveStart,
                saveEnd,
                originalCells: origCells
              })
              // Har bir fan uchun ustoz eslatmasi (izoh bo'lsa o'tkazib yuboriladi)
              if (!studentHasNote) {
                for (const block of subjectBlocks) {
                  let subjectName = ''
                  for (let r = 0; r < studentStartIdx; r++) {
                    const rowVals = rows[r]?.values || []
                    const v = (rowVals[block.start]?.formattedValue || '').trim()
                    if (v) { subjectName = v; break }
                    for (let col = block.start; col <= block.end; col++) {
                      const v2 = (rowVals[col]?.formattedValue || '').trim()
                      if (v2) { subjectName = v2; break }
                    }
                    if (subjectName) break
                  }
                  if (!subjectName) subjectName = `Ustun ${block.start + 1}`
                  subjectName = cleanSubjectName(subjectName)
                  const normSubject = subjectName.toLowerCase().replace(/\s/g, '')
                  const normClass = title.toLowerCase().replace(/\s/g, '')
                  const tgId = teacherMap.get(`${normClass}_${normSubject}`) || teacherMap.get(normSubject) || defaultTeacherTg
                  if (tgId) {
                    if (!teacherNotifications.has(tgId)) teacherNotifications.set(tgId, new Map<string, string[]>())
                    const subMap = teacherNotifications.get(tgId)!
                    const key = `${title} | ${subjectName}`
                    if (!subMap.has(key)) subMap.set(key, [])
                    subMap.get(key)!.push(studentName)
                  } else {
                    console.warn(`[BARCHA] "${subjectName}" fani uchun ${title} sinfida ustoz Telegram topilmadi (VITE_DEFAULT_TEACHER_USERNAME ham bo'sh).`)
                  }
                }
              } else {
                console.log(`[BARCHA] ${studentName} (${title}) qatorida izoh bor — ustozga xabar yuborilmaydi.`)
              }
            } else {
              // Ayrim fanlarga qatnashmagan
              for (const block of subjectBlocks) {
                if (isBlockEmpty(i, block)) {
                  // Asl qiymat va formatlarni saqlash (border uchun 1 ta katak kengaytirib saqlaymiz)
                  const saveStart = Math.max(3, block.start - 1)
                  const saveEnd = Math.min((rows[i]?.values?.length ?? block.end + 2) - 1, block.end + 2)
                  const origCells: { col: number; cellData: any }[] = []
                  for (let col = saveStart; col <= saveEnd; col++) {
                    const cell = rows[i]?.values?.[col]
                    origCells.push({
                      col,
                      cellData: cell ? {
                        userEnteredValue: cell.userEnteredValue ?? null,
                        userEnteredFormat: cell.userEnteredFormat ?? null
                      } : null
                    })
                  }
                  tempUpdates.push({
                    rowIndex: i,
                    startCol: block.start,
                    endCol: block.end + 1,
                    saveStart,
                    saveEnd,
                    originalCells: origCells
                  })
                  // Bu fan uchun ustoz eslatmasi (izoh bo'lsa o'tkazib yuboriladi)
                  if (!studentHasNote) {
                    let subjectName = ''
                    for (let r = 0; r < studentStartIdx; r++) {
                      const rowVals = rows[r]?.values || []
                      const v = (rowVals[block.start]?.formattedValue || '').trim()
                      if (v) { subjectName = v; break }
                      for (let col = block.start; col <= block.end; col++) {
                        const v2 = (rowVals[col]?.formattedValue || '').trim()
                        if (v2) { subjectName = v2; break }
                      }
                      if (subjectName) break
                    }
                    if (!subjectName) subjectName = `Ustun ${block.start + 1}`
                    subjectName = cleanSubjectName(subjectName)
                    const normSubject = subjectName.toLowerCase().replace(/\s/g, '')
                    const normClass = title.toLowerCase().replace(/\s/g, '')
                    const tgId = teacherMap.get(`${normClass}_${normSubject}`) || teacherMap.get(normSubject) || defaultTeacherTg
                    if (tgId) {
                      if (!teacherNotifications.has(tgId)) teacherNotifications.set(tgId, new Map<string, string[]>())
                      const subMap = teacherNotifications.get(tgId)!
                      const key = `${title} | ${subjectName}`
                      if (!subMap.has(key)) subMap.set(key, [])
                      subMap.get(key)!.push(studentName)
                    } else {
                      console.warn(`[BARCHA] "${subjectName}" fani uchun ${title} sinfida ustoz Telegram topilmadi (VITE_DEFAULT_TEACHER_USERNAME ham bo'sh).`)
                    }
                  } else {
                    console.log(`[BARCHA] ${studentName} (${title}) qatorida izoh bor — ustozga xabar yuborilmaydi.`)
                  }
                }
              }
            }
          }

          if (tempUpdates.length > 0) {
            const mergeRequests = tempUpdates.map(u => ({
              mergeCells: {
                range: {
                  sheetId: gid,
                  startRowIndex: u.rowIndex,
                  endRowIndex: u.rowIndex + 1,
                  startColumnIndex: u.startCol,
                  endColumnIndex: u.endCol + 1
                },
                mergeType: 'MERGE_ALL'
              }
            }))

            const updateCellsRequests = tempUpdates.map(u => ({
              updateCells: {
                rows: [
                  {
                    values: [
                      {
                        userEnteredValue: {
                          stringValue: 'qatnashmadi'
                        },
                        userEnteredFormat: {
                          horizontalAlignment: 'CENTER',
                          verticalAlignment: 'MIDDLE',
                          textFormat: {
                            italic: false,
                            bold: false
                          }
                        }
                      }
                    ]
                  }
                ],
                fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.bold',
                range: {
                  sheetId: gid,
                  startRowIndex: u.rowIndex,
                  endRowIndex: u.rowIndex + 1,
                  startColumnIndex: u.startCol,
                  endColumnIndex: u.startCol + 1
                }
              }
            }))

            try {
              await sheetsWrite.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                  requests: [...mergeRequests, ...updateCellsRequests]
                }
              })
              console.log(`${title}: ${tempUpdates.length} ta o'quvchiga "qatnashmadi" yozildi va birlashtirildi`)
            } catch (writeErr: any) {
              console.error(`${title}: "qatnashmadi" yozishda xato:`, writeErr?.message)
            }
          }
        }
      }

      // ── 3. Diapazonni PDF qilib olish va PNG ga aylantirish ────────────────
      let attempts = 0
      let success = false
      let imageBuffer: Buffer | null = null

      try {
        while (attempts < 3 && !success) {
          attempts++
          try {
            // range=${targetRange} orqali faqat jadval bor qismini kesib olamiz, landscape (portrait=false) va margins=0.0 bilan oq joylarni yo'qotamiz
            const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=pdf&gid=${gid}&range=${targetRange}&gridlines=true&printtitle=false&sheetnames=false&fzr=false&portrait=false&fitw=true&size=A4&top_margin=0.0&bottom_margin=0.0&left_margin=0.0&right_margin=0.0`

            const pdfRes = await fetch(exportUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            })

            if (pdfRes.status === 429) {
              await new Promise(r => setTimeout(r, attempts * 4000))
              continue
            }

            if (!pdfRes.ok) {
              errors.push(`${title}: PDF yuklash xatosi (${pdfRes.status})`)
              break
            }

            const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())
            const pngPages = await pdfToPng(pdfBuffer, { viewportScale: 1.5 }) // Xotira tejash uchun 1.5
            if (pngPages && pngPages.length > 0) {
              // Oq chegaralarni qirqish (avto-hisobot-ai dagi Puppeteer clip kabi)
              const raw = pngPages[0].content
              try {
                imageBuffer = await sharp(raw)
                  .trim({ background: { r: 255, g: 255, b: 255, alpha: 1 }, threshold: 15 })
                  .toBuffer()
              } catch {
                imageBuffer = raw || null // trim ishlamasa original ishlatiladi
              }
              success = true
            } else {
              errors.push(`${title}: Rasmga aylantirish xatosi`)
              break
            }
          } catch (err: any) {
            if (attempts >= 3) {
              errors.push(`${title}: yuklab bo'lmadi (${err.message})`)
            } else {
              await new Promise(r => setTimeout(r, 3000))
            }
          }
        }
      } finally {
        // ── 3.5. Qayta tiklash (Restore original state) ─────────────────────
        if (tempUpdates.length > 0) {
          const unmergeRequests = tempUpdates.map(u => ({
            unmergeCells: {
              range: {
                sheetId: gid,
                startRowIndex: u.rowIndex,
                endRowIndex: u.rowIndex + 1,
                startColumnIndex: u.startCol,
                endColumnIndex: u.endCol + 1
              }
            }
          }))

          try {
            // 1. Unmerge cells
            // 2. Asl qiymat va formatlarni (shu jumladan borderlarni va formulalarni) qaytarish
            const restoreValueRequests = tempUpdates.map(u => ({
              updateCells: {
                rows: [
                  {
                    values: u.originalCells.map(oc => {
                      // Bo'sh katak (null) — asl format yo'q, hech narsa o'zgartirmaymiz
                      if (!oc.cellData) return { userEnteredValue: {}, userEnteredFormat: {} }
                      return {
                        userEnteredValue: oc.cellData.userEnteredValue || {},
                        userEnteredFormat: oc.cellData.userEnteredFormat || {}
                      }
                    })
                  }
                ],
                fields: 'userEnteredValue,userEnteredFormat',
                range: {
                  sheetId: gid,
                  startRowIndex: u.rowIndex,
                  endRowIndex: u.rowIndex + 1,
                  startColumnIndex: u.saveStart,
                  endColumnIndex: u.saveEnd + 1
                }
              }
            }))

            await sheetsWrite.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: {
                requests: [...unmergeRequests, ...restoreValueRequests]
              }
            })
            console.log(`${title}: "qatnashmadi" yozuvlari o'chirildi, kataklar va formatlar (borderlar) qayta tiklandi`)
          } catch (restoreErr: any) {
            console.error(`${title}: Qayta tiklashda xato:`, restoreErr?.message)
          }
        }
      }

      // ── 4. Telegramga yuborish ───────────────────────────────────────────
      if (success && imageBuffer) {
        let sentViaUserbot = false
        if (userbot && userbot.connected) {
          try {
            console.log(`[USERBOT] Sinf ${title} rasmi yuborilmoqda...`)

            const { CustomFile } = await import("telegram/client/uploads.js")
            const toSend = new CustomFile(`${title}.png`, imageBuffer.length, "", imageBuffer)

            await userbot.sendFile(groupId3, {
              file: toSend,
              caption: CAPTION
            })

            sentViaUserbot = true
            sentCount++
            console.log(`[USERBOT] Sinf ${title} muvaffaqiyatli yuborildi.`)
          } catch (err: any) {
            console.error(`[USERBOT] Sinf ${title} rasmini yuborishda xato: ${err.message}. Bot orqali yuboriladi...`)
            await handleUserbotError(err)
          }
        }

        if (!sentViaUserbot) {
          try {
            const boundary = `----TGBound${Date.now()}${Math.floor(Math.random() * 9999)}`
            const head = Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${groupId3}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${CAPTION}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${title}.png"\r\nContent-Type: image/png\r\n\r\n`
            )
            const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
            const body = Buffer.concat([head, imageBuffer, tail])

            const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
              body,
            })

            const tgData = await tgRes.json() as { ok: boolean; description?: string }
            if (tgData.ok) {
              sentCount++
              console.log(`Sinf ${title} muvaffaqiyatli yuborildi.`)
            } else {
              errors.push(`${title}: Telegram xatosi (${tgData.description})`)
            }
          } catch (tgErr: any) {
            errors.push(`${title}: Telegramga yuborib bo'lmadi (${tgErr.message})`)
          }
        }
      }
      await new Promise(r => setTimeout(r, 3500))
    }

    // ── O'qituvchilarga eslatma yuborish ────────────────────────────────────
    let notificationCount = 0
    try {
      if (teacherNotifications.size > 0) {
        console.log(`[BARCHA] O'qituvchilarga eslatma yuborish boshlanmoqda... Jami: ${teacherNotifications.size} ta o'qituvchi`)
        if (userbot && userbot.connected) {
          for (const [tgId, subMap] of teacherNotifications.entries()) {
            let messageText = `Assalomu alaykum, hurmatli ustoz!\n\nHaftalik hisobot tizimi quyidagi o'quvchilar uchun baholar kiritilmaganligini aniqladi:\n\n`
            for (const [key, students] of subMap.entries()) {
              // key = "1b | Matematika"
              const parts = key.split(' | ')
              const className = parts[0] || ''
              const fanName = parts[1] || key
              const uniqueStudents = [...new Set(students)]
              messageText += `📚 ${fanName} fani, ${className} sinfi:\n`
              messageText += uniqueStudents.map(s => `   • ${s}`).join('\n') + '\n\n'
            }
            messageText += `\nIltimos, Google Sheets jadvalida baholarni to'liq kiriting. Haftalik hisobot tez orada guruhlarga yuboriladi.`
            try {
              const dest = tgId.startsWith('@') ? tgId : tgId.startsWith('-') ? tgId : `@${tgId}`
              await userbot.sendMessage(dest, { message: messageText })
              console.log(`[BARCHA] Ustozga xabar yuborildi: ${dest}`)
              notificationCount++
            } catch (sendErr: any) {
              console.error(`[BARCHA] Xabarni ${tgId} ga yuborishda xatolik:`, sendErr.message)
            }
          }
        } else {
          console.warn(`[BARCHA] O'qituvchilarga xabar yuborish uchun shaxsiy Telegram profil (Userbot) ulanmagan!`)
        }
      }
    } finally {
      if (userbot) {
        try {
          await userbot.disconnect()
        } catch {}
      }
    }

    const noteMsg = notificationCount > 0 ? ` [${notificationCount} ta ustozga ogohlantirish yuborildi]` : ''
    sendJson(res, 200, { success: true, message: `${sentCount} ta sinf yuborildi ✅${noteMsg}` })
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || 'Noma\'lum xato' })
  }
}

// ─── Alohida guruhlar: har bir sinfni o'z guruhiga yuborish ────────────────
// .env kalitlari: VITE_CLASS_GROUP_5_BLUE, VITE_CLASS_GROUP_6_GREEN, va h.k.
async function handleAlohida(res: any) {
  const env = readEnv()
  const originalSpreadsheetUrl = (env['VITE_SPREADSHEET_ID'] || '').trim()
  let spreadsheetId = originalSpreadsheetUrl
  const botToken = (env['VITE_TELEGRAM_BOT_TOKEN'] || '').trim()
  const serviceEmail = (env['GOOGLE_SERVICE_EMAIL'] || '').trim()
  const privateKey = (env['GOOGLE_PRIVATE_KEY'] || '').replace(/\\n/g, '\n').trim()

  if (spreadsheetId.includes('docs.google.com/spreadsheets')) {
    const match = spreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
    if (match && match[1]) spreadsheetId = match[1]
  }

  if (!spreadsheetId || !botToken || !serviceEmail || !privateKey) {
    sendJson(res, 400, { error: 'Asosiy sozlamalar to\'liq emas (spreadsheetId, botToken, serviceEmail, privateKey)' })
    return
  }

  // Sheet nomidan guruh ID ni topuvchi yordamchi funksiya
  // Masalan: "5B" → VITE_CLASS_GROUP_5_BLUE, "5G" → VITE_CLASS_GROUP_5_GREEN
  function getGroupIdForSheet(title: string): { groupId: string; colorLabel: string } {
    const t = title.trim()
    // Boshidagi raqamni ajratib olish (5B → 5, 10G → 10)
    const numMatch = t.match(/^(\d+)/)
    const num = numMatch ? numMatch[1] : ''

    // Rang aniqlash: G → GREEN, qolganlar → BLUE
    const tLower = t.toLowerCase()
    let colorSuffix = 'BLUE'
    let colorLabel = `${num}-sinf Blue (📘)`

    if (tLower.includes('g')) {
      colorSuffix = 'GREEN'
      colorLabel = `${num}-sinf Green (📗)`
    }

    // Kalit: VITE_CLASS_GROUP_5_BLUE yoki VITE_CLASS_GROUP_5_GREEN
    const envKey = num ? `VITE_CLASS_GROUP_${num}_${colorSuffix}` : ''
    const groupId = envKey ? (env[envKey] || '').trim() : ''
    return { groupId, colorLabel }
  }

  try {
    const { google } = await import('googleapis')

    const auth = new google.auth.JWT({
      email: serviceEmail,
      key: privateKey,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    })

    const authWrite = new google.auth.JWT({
      email: serviceEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })

    const sheets = google.sheets({ version: 'v4', auth })
    const sheetsWrite = google.sheets({ version: 'v4', auth: authWrite })

    console.log("[ALOHIDA] Sheet ro'yxatini yuklash...")
    const spreadsheetMeta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    })
    const sheetList = spreadsheetMeta.data.sheets || []
    const tokenRes = await auth.getAccessToken()
    const accessToken = tokenRes.token

    // ── O'qituvchilar ro'yxatini o'qish ──────────────────────────────────────
    const teachersSpreadsheetUrl = (env['VITE_TEACHERS_SPREADSHEET_ID'] || '').trim() || originalSpreadsheetUrl
    let teachersSpreadsheetId = teachersSpreadsheetUrl
    if (teachersSpreadsheetId.includes('docs.google.com/spreadsheets')) {
      const match = teachersSpreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
      if (match && match[1]) teachersSpreadsheetId = match[1]
    }

    const teacherMap = new Map<string, string>() // class_subject -> telegram, subject -> telegram
    let defaultTeacherTg = (env['VITE_DEFAULT_TEACHER_USERNAME'] || '').trim()
    if (defaultTeacherTg.startsWith('https://t.me/')) defaultTeacherTg = defaultTeacherTg.replace('https://t.me/', '')
    if (defaultTeacherTg.startsWith('http://t.me/')) defaultTeacherTg = defaultTeacherTg.replace('http://t.me/', '')
    if (defaultTeacherTg.startsWith('t.me/')) defaultTeacherTg = defaultTeacherTg.replace('t.me/', '')
    defaultTeacherTg = defaultTeacherTg.replace(/\/$/, '').trim()

    try {
      console.log(`[ALOHIDA] O'qituvchilar jadvalidan sheet ro'yxatini o'qish (${teachersSpreadsheetId})...`)
      const teachersMeta = await sheets.spreadsheets.get({
        spreadsheetId: teachersSpreadsheetId,
        fields: 'sheets.properties',
      })
      const teachersSheetList = teachersMeta.data.sheets || []
      
      const teacherSheet = teachersSheetList.find(s => {
        const t = (s.properties?.title || '').toLowerCase()
        return t.includes("o'qituvchi") || t.includes("o`qituvchi") || t.includes("o'qituvchi") || t.includes("учител") || t.includes("teacher")
      })

      if (teacherSheet) {
        const teacherSheetTitle = teacherSheet.properties?.title || ''
        const teacherValRes = await sheets.spreadsheets.values.get({
          spreadsheetId: teachersSpreadsheetId,
          range: `'${teacherSheetTitle.replace(/'/g, "''")}'!A1:C200`,
          valueRenderOption: 'FORMATTED_VALUE',
        })
        const teacherRows = teacherValRes.data.values || []
        
        let isOldFormat = false
        if (teacherRows.length > 0) {
          const firstRow = teacherRows[0]
          if (firstRow.length <= 2) {
            isOldFormat = true
          }
        }

        if (isOldFormat) {
          for (const r of teacherRows) {
            const subject = cleanSubjectName(r[0] || '').trim().toLowerCase().replace(/\s/g, '')
            let tg = (r[1] || '').trim()
            if (tg.startsWith('https://t.me/')) tg = tg.replace('https://t.me/', '')
            if (tg.startsWith('http://t.me/')) tg = tg.replace('http://t.me/', '')
            if (tg.startsWith('t.me/')) tg = tg.replace('t.me/', '')
            tg = tg.replace(/\/$/, '').trim()
            if (subject && subject !== "fannomi" && subject !== "subjectname" && tg) {
              teacherMap.set(subject, tg)
            }
          }
        } else {
          for (const r of teacherRows) {
            const cls = (r[0] || '').trim().toLowerCase().replace(/\s/g, '')
            const subject = cleanSubjectName(r[1] || '').trim().toLowerCase().replace(/\s/g, '')
            let tg = (r[2] || '').trim()
            if (tg.startsWith('https://t.me/')) tg = tg.replace('https://t.me/', '')
            if (tg.startsWith('http://t.me/')) tg = tg.replace('http://t.me/', '')
            if (tg.startsWith('t.me/')) tg = tg.replace('t.me/', '')
            tg = tg.replace(/\/$/, '').trim()
            if (cls && subject && cls !== "sinf" && cls !== "class" && subject !== "fannomi" && subject !== "subjectname" && tg) {
              teacherMap.set(`${cls}_${subject}`, tg)
            }
          }
        }
        console.log(`[ALOHIDA] O'qituvchilar yuklandi: ${teacherMap.size} ta`)
      } else {
        console.warn("[ALOHIDA] O'qituvchilar jadvalida 'O'qituvchilar' varag'i topilmadi.")
      }
    } catch (err: any) {
      console.error("[ALOHIDA] O'qituvchilar ro'yxatini o'qishda xatolik:", err.message)
    }

    const teacherNotifications = new Map<string, Map<string, string[]>>() // tgId -> Map<subject, classes[]>

    const visibleSheets = sheetList.filter(s => {
      const t = s.properties?.title || '';
      const isTeacherSheet = t.toLowerCase().includes("o'qituvchi") || t.toLowerCase().includes("o`qituvchi") || t.toLowerCase().includes("учител") || t.toLowerCase().includes("teacher");
      return !s.properties?.hidden && !isTeacherSheet;
    })

    let sentCount = 0
    const skipped: string[] = []
    const errors: string[] = []

    console.log(`[ALOHIDA] Jami sinflar: ${visibleSheets.length}. Rang guruhlariga yuborish boshlanmoqda...`)

    // Userbotni boshida bir marta ulab qo'yamiz va butun jarayon davomida ishlatamiz
    const userbot = await getUserbotClient()
    if (userbot) {
      try {
        console.log("[USERBOT] Boshlang'ich ulanish...")
        await connectUserbot(userbot)
      } catch (err: any) {
        console.error("[USERBOT] Boshlang'ich ulanishda xato:", err.message)
      }
    }

    for (const sheet of visibleSheets) {
      const gid = sheet.properties?.sheetId
      const title = sheet.properties?.title || `Sheet${gid}`

      // ── Guruh ID ni topish ──────────────────────────────────────────────────
      const { groupId: targetGroupId, colorLabel } = getGroupIdForSheet(title)

      if (!targetGroupId) {
        console.warn(`[ALOHIDA] ${title}: guruh ID topilmadi (${colorLabel}), o'tkazib yuborildi.`)
        skipped.push(title)
        continue
      }

      console.log(`[ALOHIDA] ${title} → ${colorLabel} guruhiga yuborilmoqda...`)

      // ── Sheet ma'lumotlarini olish ────────────────────────────────────────
      const sheetDataRes = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${title}'!A1:Z500`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values(formattedValue,effectiveValue,userEnteredValue,userEnteredFormat,note)',
      })
      const rows = sheetDataRes.data.sheets?.[0]?.data?.[0]?.rowData || []

      // O'quvchi qatorida izoh (note) bor-yo'qligini aniqlash uchun yordamchi
      // Tekshiradi: 1) Google Sheets note (popup izoh), 2) katak qiymatida "izoh" so'zi
      const rowHasNote = (rowIndex: number): boolean => {
        const vals = rows[rowIndex]?.values || []
        return vals.some((cell: any) => {
          // 1. Google Sheets popup note
          if (typeof cell?.note === 'string' && cell.note.trim() !== '') return true
          // 2. Katak qiymatida "izoh" so'zi (katta-kichik harfdan qat'i nazar)
          const cellText = (cell?.formattedValue || cell?.effectiveValue?.stringValue || '').toLowerCase()
          if (cellText.includes('izoh')) return true
          return false
        })
      }

      let ortachaRowIdx = -1
      let umumiyColIdx = -1

      for (let r = 0; r < rows.length; r++) {
        const values = rows[r]?.values || []
        for (let c = 0; c < values.length; c++) {
          const val = (values[c]?.formattedValue || '').toLowerCase().replace(/\s/g, '')
          const isOrtacha = val.includes("ort") || val.includes("o'rt") || val.includes("o'rt") || val.includes("o`rt") || val.includes("ўрт") || val.includes("сред")
          if (isOrtacha && r > 2) ortachaRowIdx = r
          if (val.includes("umumiy%") || (val.includes("umumiy") && val.includes("%")) || val.includes("умумий%")) {
            umumiyColIdx = c
          }
        }
      }

      let endRow = rows.length
      let endColLetter = 'Z'

      if (ortachaRowIdx !== -1) {
        endRow = ortachaRowIdx + 1
      } else {
        let maxRow = 0
        for (let r = 0; r < rows.length; r++) {
          const values = rows[r]?.values || []
          for (let c = 0; c < values.length; c++) {
            const val = values[c]?.formattedValue
            if (val !== undefined && val !== null && val.trim() !== '') {
              if (r > maxRow) maxRow = r
            }
          }
        }
        endRow = maxRow + 1
      }

      if (umumiyColIdx !== -1) {
        endColLetter = colLetter(umumiyColIdx)
      } else {
        let maxCol = 0
        for (let r = 0; r < rows.length; r++) {
          const values = rows[r]?.values || []
          for (let c = 0; c < values.length; c++) {
            const val = values[c]?.formattedValue
            if (val !== undefined && val !== null && val.trim() !== '') {
              if (c > maxCol) maxCol = c
            }
          }
        }
        endColLetter = colLetter(maxCol)
      }

      const targetRange = `A1:${endColLetter}${endRow}`
      const tempUpdates: { rowIndex: number; startCol: number; endCol: number; saveStart: number; saveEnd: number; originalCells: { col: number; cellData: any }[] }[] = []

      // ── "Qatnashmadi" yozish ─────────────────────────────────────────────
      let studentStartIdx = -1
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]?.values?.[0]?.effectiveValue?.numberValue === 1) {
          studentStartIdx = i
          break
        }
      }

      if (studentStartIdx !== -1) {
        const firstStudentRow = rows[studentStartIdx]
        const formulaCols = new Set<number>()
        const maxColCount = firstStudentRow?.values?.length || 0

        for (let col = 3; col < maxColCount; col++) {
          const cell = firstStudentRow?.values?.[col]
          if (cell?.userEnteredValue?.formulaValue) formulaCols.add(col)
        }

        let ortachaColIdx = -1
        for (let r = 0; r < studentStartIdx; r++) {
          const values = rows[r]?.values || []
          for (let c = 3; c < values.length; c++) {
            const val = (values[c]?.formattedValue || '').toLowerCase().replace(/\s/g, '')
            if (val.includes("ortacha") || val.includes("o'rtacha") || val.includes("o`rtacha") || val.includes("ўртача") || val.includes("сред")) {
              ortachaColIdx = c
              break
            }
          }
          if (ortachaColIdx !== -1) break
        }

        const colLimit = umumiyColIdx !== -1 ? umumiyColIdx : maxColCount
        const subjectLimit = ortachaColIdx !== -1 ? ortachaColIdx : (umumiyColIdx !== -1 ? umumiyColIdx - 2 : maxColCount)

        const subjectBlocks: { start: number; end: number }[] = []
        let currentBlock: number[] = []

        for (let col = 3; col < subjectLimit; col++) {
          if (!formulaCols.has(col)) {
            currentBlock.push(col)
          } else {
            if (currentBlock.length > 0) {
              subjectBlocks.push({ start: currentBlock[0], end: currentBlock[currentBlock.length - 1] })
              currentBlock = []
            }
          }
        }
        if (currentBlock.length > 0) {
          subjectBlocks.push({ start: currentBlock[0], end: currentBlock[currentBlock.length - 1] })
        }

        const isBlockEmpty = (rowIndex: number, block: { start: number; end: number }) => {
          for (let col = block.start; col <= block.end; col++) {
            const cell = rows[rowIndex]?.values?.[col]
            const val = (cell?.formattedValue || cell?.effectiveValue?.stringValue || '').trim()
            if (val !== '') return false
          }
          return true
        }

        if (subjectBlocks.length > 0) {
          // O'qituvchilarga xabar yuborish uchun baholanmagan fanlarni aniqlash
          for (const block of subjectBlocks) {
            let allStudentsEmpty = true
            for (let i = studentStartIdx; i < rows.length; i++) {
              const rowNum = rows[i]?.values?.[0]?.effectiveValue?.numberValue
              if (typeof rowNum !== 'number' || rowNum <= 0) continue
              if (ortachaRowIdx !== -1 && i >= ortachaRowIdx) break

              if (!isBlockEmpty(i, block)) {
                allStudentsEmpty = false
                break
              }
            }

            if (allStudentsEmpty) {
              // Fan nomini sarlavhadan topish
              let subjectName = ''
              for (let r = 0; r < studentStartIdx; r++) {
                const rowVals = rows[r]?.values || []
                const v = (rowVals[block.start]?.formattedValue || '').trim()
                if (v) { subjectName = v; break }
                for (let col = block.start; col <= block.end; col++) {
                  const v2 = (rowVals[col]?.formattedValue || '').trim()
                  if (v2) { subjectName = v2; break }
                }
                if (subjectName) break
              }

              if (!subjectName) {
                subjectName = `Ustun ${block.start + 1}`
              }
              subjectName = cleanSubjectName(subjectName)

              const normSubject = subjectName.toLowerCase().replace(/\s/g, '')
              const normClass = title.toLowerCase().replace(/\s/g, '')
              const tgId = teacherMap.get(`${normClass}_${normSubject}`) || teacherMap.get(normSubject) || defaultTeacherTg

              if (tgId) {
                if (!teacherNotifications.has(tgId)) {
                  teacherNotifications.set(tgId, new Map<string, string[]>())
                }
                const subMap = teacherNotifications.get(tgId)!
                if (!subMap.has(subjectName)) {
                  subMap.set(subjectName, [])
                }
                subMap.get(subjectName)!.push(title)
              } else {
                console.warn(`[ALOHIDA] "${subjectName}" fani uchun o'qituvchi Telegram username topilmadi (VITE_DEFAULT_TEACHER_USERNAME ham bo'sh).`)
              }
            }
          }

          for (let i = studentStartIdx; i < rows.length; i++) {
            const rowNum = rows[i]?.values?.[0]?.effectiveValue?.numberValue
            if (typeof rowNum !== 'number' || rowNum <= 0) continue
            if (ortachaRowIdx !== -1 && i >= ortachaRowIdx) break

            // O'quvchi ismini olish
            const studentName =
              (rows[i]?.values?.[1]?.formattedValue || rows[i]?.values?.[2]?.formattedValue || `${rowNum}-o'quvchi`).trim()

            // Agar o'quvchi qatorida izoh (note) bo'lsa — ustozga xabar yubormaylik
            const studentHasNote = rowHasNote(i)

            let allSubjectsEmpty = true
            for (const block of subjectBlocks) {
              if (!isBlockEmpty(i, block)) { allSubjectsEmpty = false; break }
            }

            if (allSubjectsEmpty) {
              const saveStart = Math.max(3, subjectBlocks[0].start - 1)
              const saveEnd = Math.min((rows[i]?.values?.length ?? colLimit) - 1, colLimit + 1)
              const origCells: { col: number; cellData: any }[] = []
              for (let col = saveStart; col <= saveEnd; col++) {
                const cell = rows[i]?.values?.[col]
                origCells.push({
                  col,
                  cellData: cell ? {
                    userEnteredValue: cell.userEnteredValue ?? null,
                    userEnteredFormat: cell.userEnteredFormat ?? null
                  } : null
                })
              }
              tempUpdates.push({ rowIndex: i, startCol: subjectBlocks[0].start, endCol: colLimit, saveStart, saveEnd, originalCells: origCells })
              // Ustozga xabar (izoh bo'lsa o'tkazib yuboriladi)
              if (!studentHasNote) {
                for (const block of subjectBlocks) {
                  let subjectName = ''
                  for (let r = 0; r < studentStartIdx; r++) {
                    const rowVals = rows[r]?.values || []
                    const v = (rowVals[block.start]?.formattedValue || '').trim()
                    if (v) { subjectName = v; break }
                    for (let col = block.start; col <= block.end; col++) {
                      const v2 = (rowVals[col]?.formattedValue || '').trim()
                      if (v2) { subjectName = v2; break }
                    }
                    if (subjectName) break
                  }
                  if (!subjectName) subjectName = `Ustun ${block.start + 1}`
                  subjectName = cleanSubjectName(subjectName)
                  const normSubject = subjectName.toLowerCase().replace(/\s/g, '')
                  const normClass = title.toLowerCase().replace(/\s/g, '')
                  const tgId = teacherMap.get(`${normClass}_${normSubject}`) || teacherMap.get(normSubject) || defaultTeacherTg
                  if (tgId) {
                    if (!teacherNotifications.has(tgId)) teacherNotifications.set(tgId, new Map<string, string[]>())
                    const subMap = teacherNotifications.get(tgId)!
                    const key = `${title} | ${subjectName}`
                    if (!subMap.has(key)) subMap.set(key, [])
                    subMap.get(key)!.push(studentName)
                  } else {
                    console.warn(`[ALOHIDA] "${subjectName}" fani uchun ${title} sinfida ustoz Telegram topilmadi.`)
                  }
                }
              } else {
                console.log(`[ALOHIDA] ${studentName} (${title}) qatorida izoh bor — ustozga xabar yuborilmaydi.`)
              }
            } else {
              for (const block of subjectBlocks) {
                if (isBlockEmpty(i, block)) {
                  const saveStart = Math.max(3, block.start - 1)
                  const saveEnd = Math.min((rows[i]?.values?.length ?? block.end + 2) - 1, block.end + 2)
                  const origCells: { col: number; cellData: any }[] = []
                  for (let col = saveStart; col <= saveEnd; col++) {
                    const cell = rows[i]?.values?.[col]
                    origCells.push({
                      col,
                      cellData: cell ? {
                        userEnteredValue: cell.userEnteredValue ?? null,
                        userEnteredFormat: cell.userEnteredFormat ?? null
                      } : null
                    })
                  }
                  tempUpdates.push({ rowIndex: i, startCol: block.start, endCol: block.end + 1, saveStart, saveEnd, originalCells: origCells })
                  // Ustozga xabar (izoh bo'lsa o'tkazib yuboriladi)
                  if (!studentHasNote) {
                    let subjectName = ''
                    for (let r = 0; r < studentStartIdx; r++) {
                      const rowVals = rows[r]?.values || []
                      const v = (rowVals[block.start]?.formattedValue || '').trim()
                      if (v) { subjectName = v; break }
                      for (let col = block.start; col <= block.end; col++) {
                        const v2 = (rowVals[col]?.formattedValue || '').trim()
                        if (v2) { subjectName = v2; break }
                      }
                      if (subjectName) break
                    }
                    if (!subjectName) subjectName = `Ustun ${block.start + 1}`
                    subjectName = cleanSubjectName(subjectName)
                    const normSubject = subjectName.toLowerCase().replace(/\s/g, '')
                    const normClass = title.toLowerCase().replace(/\s/g, '')
                    const tgId = teacherMap.get(`${normClass}_${normSubject}`) || teacherMap.get(normSubject) || defaultTeacherTg
                    if (tgId) {
                      if (!teacherNotifications.has(tgId)) teacherNotifications.set(tgId, new Map<string, string[]>())
                      const subMap = teacherNotifications.get(tgId)!
                      const key = `${title} | ${subjectName}`
                      if (!subMap.has(key)) subMap.set(key, [])
                      subMap.get(key)!.push(studentName)
                    } else {
                      console.warn(`[ALOHIDA] "${subjectName}" fani uchun ${title} sinfida ustoz Telegram topilmadi.`)
                    }
                  } else {
                    console.log(`[ALOHIDA] ${studentName} (${title}) qatorida izoh bor — ustozga xabar yuborilmaydi.`)
                  }
                }
              }
            }
          }

          if (tempUpdates.length > 0) {
            const mergeRequests = tempUpdates.map(u => ({
              mergeCells: {
                range: { sheetId: gid, startRowIndex: u.rowIndex, endRowIndex: u.rowIndex + 1, startColumnIndex: u.startCol, endColumnIndex: u.endCol + 1 },
                mergeType: 'MERGE_ALL'
              }
            }))
            const updateCellsRequests = tempUpdates.map(u => ({
              updateCells: {
                rows: [{ values: [{ userEnteredValue: { stringValue: 'qatnashmadi' }, userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { italic: false, bold: false } } }] }],
                fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.bold',
                range: { sheetId: gid, startRowIndex: u.rowIndex, endRowIndex: u.rowIndex + 1, startColumnIndex: u.startCol, endColumnIndex: u.startCol + 1 }
              }
            }))
            try {
              await sheetsWrite.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [...mergeRequests, ...updateCellsRequests] }
              })
            } catch (writeErr: any) {
              console.error(`[ALOHIDA] ${title}: "qatnashmadi" yozishda xato:`, writeErr?.message)
            }
          }
        }
      }

      // ── PDF → PNG ────────────────────────────────────────────────────────
      let attempts = 0
      let success = false
      let imageBuffer: Buffer | null = null

      try {
        while (attempts < 3 && !success) {
          attempts++
          try {
            const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=pdf&gid=${gid}&range=${targetRange}&gridlines=true&printtitle=false&sheetnames=false&fzr=false&portrait=false&fitw=true&size=A4&top_margin=0.0&bottom_margin=0.0&left_margin=0.0&right_margin=0.0`
            const pdfRes = await fetch(exportUrl, { headers: { Authorization: `Bearer ${accessToken}` } })

            if (pdfRes.status === 429) { await new Promise(r => setTimeout(r, attempts * 4000)); continue }
            if (!pdfRes.ok) { errors.push(`${title}: PDF yuklash xatosi (${pdfRes.status})`); break }

            const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())
            const pngPages = await pdfToPng(pdfBuffer, { viewportScale: 1.5 })
            if (pngPages && pngPages.length > 0) {
              const raw = pngPages[0].content
              try {
                imageBuffer = await sharp(raw)
                  .trim({ background: { r: 255, g: 255, b: 255, alpha: 1 }, threshold: 15 })
                  .toBuffer()
              } catch {
                imageBuffer = raw || null
              }
              success = true
            } else {
              errors.push(`${title}: Rasmga aylantirish xatosi`)
              break
            }
          } catch (err: any) {
            if (attempts >= 3) errors.push(`${title}: yuklab bo'lmadi (${err.message})`)
            else await new Promise(r => setTimeout(r, 3000))
          }
        }
      } finally {
        // ── Restore ─────────────────────────────────────────────────────────
        if (tempUpdates.length > 0) {
          const unmergeRequests = tempUpdates.map(u => ({
            unmergeCells: {
              range: { sheetId: gid, startRowIndex: u.rowIndex, endRowIndex: u.rowIndex + 1, startColumnIndex: u.startCol, endColumnIndex: u.endCol + 1 }
            }
          }))
          try {
            // 1. Unmerge
            // 2. Asl qiymat va formatlarni (shu jumladan borderlarni va formulalarni) qaytarish
            const restoreValueRequests = tempUpdates.map(u => ({
              updateCells: {
                rows: [
                  {
                    values: u.originalCells.map(oc => {
                      // Bo'sh katak — asl format yo'q edi, bo'sh format qaytaramiz
                      if (!oc.cellData) return { userEnteredValue: {}, userEnteredFormat: {} }
                      return {
                        userEnteredValue: oc.cellData.userEnteredValue || {},
                        userEnteredFormat: oc.cellData.userEnteredFormat || {}
                      }
                    })
                  }
                ],
                fields: 'userEnteredValue,userEnteredFormat',
                range: {
                  sheetId: gid,
                  startRowIndex: u.rowIndex,
                  endRowIndex: u.rowIndex + 1,
                  startColumnIndex: u.saveStart,
                  endColumnIndex: u.saveEnd + 1
                }
              }
            }))
            await sheetsWrite.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: { requests: [...unmergeRequests, ...restoreValueRequests] }
            })
          } catch (restoreErr: any) {
            console.error(`[ALOHIDA] ${title}: Qayta tiklashda xato:`, restoreErr?.message)
          }
        }
      }

      // ── Telegramga yuborish ──────────────────────────────────────────────
      if (success && imageBuffer) {
        let sentViaUserbot = false
        if (userbot && userbot.connected) {
          try {
            const { CustomFile } = await import("telegram/client/uploads.js")
            const toSend = new CustomFile(`${title}.png`, imageBuffer.length, "", imageBuffer)
            await userbot.sendFile(targetGroupId, { file: toSend, caption: CAPTION })
            sentViaUserbot = true
            sentCount++
            console.log(`[ALOHIDA] ${title} → ${colorLabel}: muvaffaqiyatli yuborildi.`)
          } catch (err: any) {
            console.error(`[ALOHIDA] ${title} userbotda xato: ${err.message}. Bot orqali yuboriladi...`)
            await handleUserbotError(err)
          }
        }

        if (!sentViaUserbot) {
          try {
            const boundary = `----TGBound${Date.now()}${Math.floor(Math.random() * 9999)}`
            const head = Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${targetGroupId}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${CAPTION}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${title}.png"\r\nContent-Type: image/png\r\n\r\n`
            )
            const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
            const body = Buffer.concat([head, imageBuffer, tail])
            const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
              body,
            })
            const tgData = await tgRes.json() as { ok: boolean; description?: string }
            if (tgData.ok) {
              sentCount++
              console.log(`[ALOHIDA] ${title} → ${colorLabel}: bot orqali yuborildi.`)
            } else {
              errors.push(`${title}: Telegram xatosi (${tgData.description})`)
            }
          } catch (tgErr: any) {
            errors.push(`${title}: Telegramga yuborib bo'lmadi (${tgErr.message})`)
          }
        }
      }

      await new Promise(r => setTimeout(r, 3500))
    }

    // ── O'qituvchilarga eslatma yuborish ────────────────────────────────────
    let notificationCount = 0
    try {
      if (teacherNotifications.size > 0) {
        console.log(`[ALOHIDA] O'qituvchilarga eslatma yuborish boshlanmoqda... Jami: ${teacherNotifications.size} ta o'qituvchi`)
        if (userbot && userbot.connected) {
          for (const [tgId, subMap] of teacherNotifications.entries()) {
            let messageText = `Assalomu alaykum, hurmatli ustoz!\n\nHaftalik hisobot tizimi quyidagi o'quvchilar uchun baholar kiritilmaganligini aniqladi:\n\n`
            for (const [key, students] of subMap.entries()) {
              // key = "1b | Matematika" yoki faqat "Matematika" (allStudentsEmpty holati)
              const parts = key.split(' | ')
              const className = parts.length >= 2 ? parts[0] : ''
              const fanName = parts.length >= 2 ? parts[1] : key
              const uniqueStudents = [...new Set(students)]
              if (className) {
                messageText += `📚 ${fanName} fani, ${className} sinfi:\n`
              } else {
                messageText += `📚 ${fanName} fani:\n`
              }
              messageText += uniqueStudents.map(s => `   • ${s}`).join('\n') + '\n\n'
            }
            messageText += `\nIltimos, Google Sheets jadvalida baholarni to'liq kiriting. Haftalik hisobot tez orada guruhlarga yuboriladi.`

            try {
              const dest = tgId.startsWith('@') ? tgId : tgId.startsWith('-') ? tgId : `@${tgId}`
              await userbot.sendMessage(dest, { message: messageText })
              console.log(`[ALOHIDA] Ustozga xabar yuborildi: ${dest}`)
              notificationCount++
            } catch (sendErr: any) {
              console.error(`[ALOHIDA] Xabarni ${tgId} ga yuborishda xatolik:`, sendErr.message)
            }
          }
        } else {
          console.warn(`[ALOHIDA] O'qituvchilarga xabar yuborish uchun shaxsiy Telegram profil (Userbot) ulanmagan!`)
        }
      }
    } finally {
      if (userbot) {
        try {
          await userbot.disconnect()
        } catch {}
      }
    }

    const skipMsg = skipped.length > 0 ? ` (${skipped.length} ta o'tkazildi: ${skipped.join(', ')})` : ''
    const noteMsg = notificationCount > 0 ? ` [${notificationCount} ta ustozga ogohlantirish yuborildi]` : ''
    sendJson(res, 200, { success: true, message: `${sentCount} ta sinf o'z guruhiga yuborildi ✅${skipMsg}${noteMsg}` })
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || 'Noma\'lum xato' })
  }
}

// ─── O'qituvchilar varag'ini avtomatik to'ldirish ───────────────────────────
async function handleFillTeachers(res: any) {
  const env = readEnv()
  const originalSpreadsheetUrl = (env['VITE_SPREADSHEET_ID'] || '').trim()
  let spreadsheetId = originalSpreadsheetUrl
  const serviceEmail = (env['GOOGLE_SERVICE_EMAIL'] || '').trim()
  const privateKey = (env['GOOGLE_PRIVATE_KEY'] || '').replace(/\\n/g, '\n').trim()

  if (spreadsheetId.includes('docs.google.com/spreadsheets')) {
    const match = spreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
    if (match && match[1]) spreadsheetId = match[1]
  }

  const teachersSpreadsheetUrl = (env['VITE_TEACHERS_SPREADSHEET_ID'] || '').trim() || originalSpreadsheetUrl
  let teachersSpreadsheetId = teachersSpreadsheetUrl
  if (teachersSpreadsheetId.includes('docs.google.com/spreadsheets')) {
    const match = teachersSpreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/)
    if (match && match[1]) teachersSpreadsheetId = match[1]
  }

  if (!spreadsheetId || !teachersSpreadsheetId || !serviceEmail || !privateKey) {
    sendJson(res, 400, {
      error: 'Google Sheets integratsiyasi sozlamalari to\'liq emas',
      missing: { spreadsheetId: !spreadsheetId, teachersSpreadsheetId: !teachersSpreadsheetId, serviceEmail: !serviceEmail, privateKey: !privateKey }
    })
    return
  }

  try {
    const { google } = await import('googleapis')

    const auth = new google.auth.JWT({
      email: serviceEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })

    const sheets = google.sheets({ version: 'v4', auth })

    // 1. Asosiy sheetlar ro'yxatini yuklash (fan va sinflarni skan qilish uchun)
    console.log("[FILL_TEACHERS] Asosiy sheet ro'yxatini yuklash...")
    const spreadsheetMeta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    })
    const sheetList = spreadsheetMeta.data.sheets || []

    // 2. O'qituvchilar jadvali sheet ro'yxatini alohida o'qituvchilar jadvalidan yuklash
    console.log("[FILL_TEACHERS] O'qituvchilar jadvali sheet ro'yxatini yuklash...")
    const teachersSpreadsheetMeta = await sheets.spreadsheets.get({
      spreadsheetId: teachersSpreadsheetId,
      fields: 'sheets.properties',
    })
    const teachersSheetList = teachersSpreadsheetMeta.data.sheets || []

    const teacherSheet = teachersSheetList.find(s => {
      const t = (s.properties?.title || '').toLowerCase()
      return t.includes("o'qituvchi") || t.includes("o`qituvchi") || t.includes("o'qituvchi") || t.includes("учител") || t.includes("teacher")
    })
    
    let teacherSheetTitle = teacherSheet?.properties?.title || "O'qituvchilar"
    let teacherSheetGid = teacherSheet?.properties?.sheetId || 0

    if (!teacherSheet) {
      // O'qituvchilar jadvalida varaq yaratish
      try {
        const addSheetRes = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: teachersSpreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: teacherSheetTitle,
                  },
                },
              },
            ],
          },
        })
        teacherSheetGid = addSheetRes.data.replies?.[0]?.addSheet?.properties?.sheetId || 0
        console.log(`[FILL_TEACHERS] Yangi varaq yaratildi: ${teacherSheetTitle} (GID: ${teacherSheetGid})`)
      } catch (err: any) {
        console.error(`[FILL_TEACHERS] Varaq yaratishda xato:`, err.message)
      }
    }

    // 3. Mavjud o'qituvchilar jadvalidagi ma'lumotlarni o'qish (Telegram foydalanuvchilarini saqlash uchun)
    const existingTeachers = new Map<string, string>() // class_subject -> telegram, or subject -> telegram for old format
    let isOldFormat = false

    if (teacherSheet) {
      try {
        const teacherValRes = await sheets.spreadsheets.values.get({
          spreadsheetId: teachersSpreadsheetId,
          range: `'${teacherSheetTitle.replace(/'/g, "''")}'!A1:C200`,
          valueRenderOption: 'FORMATTED_VALUE',
        })
        const teacherRows = teacherValRes.data.values || []

        if (teacherRows.length > 0) {
          const firstRow = teacherRows[0]
          if (firstRow.length <= 2) {
            isOldFormat = true
          }
        }

        if (isOldFormat) {
          for (const r of teacherRows) {
            const rawSubject = cleanSubjectName((r[0] || '').trim())
            const normSubject = rawSubject.toLowerCase().replace(/\s/g, '')
            const tg = (r[1] || '').trim()
            if (rawSubject && normSubject !== "fannomi" && normSubject !== "subjectname") {
              existingTeachers.set(normSubject, tg)
            }
          }
        } else {
          for (const r of teacherRows) {
            const rawClass = (r[0] || '').trim()
            const rawSubject = cleanSubjectName((r[1] || '').trim())
            const tg = (r[2] || '').trim()
            const normClass = rawClass.toLowerCase().replace(/\s/g, '')
            const normSubject = rawSubject.toLowerCase().replace(/\s/g, '')
            if (rawClass && rawSubject && normClass !== "sinf" && normClass !== "class" && normSubject !== "fannomi" && normSubject !== "subjectname") {
              existingTeachers.set(`${normClass}_${normSubject}`, tg)
            }
          }
        }
        console.log(`[FILL_TEACHERS] Mavjud o'qituvchilar yuklandi: ${existingTeachers.size} ta`)
      } catch (err: any) {
        console.error("[FILL_TEACHERS] Mavjud o'qituvchilar ro'yxatini o'qishda xato:", err.message)
      }
    }

    // 4. Barcha sinf (visible) varaqlarini ko'rib chiqish va fanlarni yig'ish (asosiy jadvaldan)
    const visibleSheets = sheetList.filter(s => {
      const t = s.properties?.title || '';
      const isTeacherSheet = t.toLowerCase().includes("o'qituvchi") || t.toLowerCase().includes("o`qituvchi") || t.toLowerCase().includes("учител") || t.toLowerCase().includes("teacher");
      return !s.properties?.hidden && !isTeacherSheet;
    })

    // class_subject -> { classOriginal, subjectOriginal }
    const discoveredEntries = new Map<string, { classOriginal: string, subjectOriginal: string }>()

    for (const sheet of visibleSheets) {
      const title = sheet.properties?.title || ''
      const sheetDataRes = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${title}'!A1:Z100`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values(formattedValue,effectiveValue,userEnteredValue.formulaValue)',
      })
      const rows = sheetDataRes.data.sheets?.[0]?.data?.[0]?.rowData || []

      // studentStartIdx topish (A ustunida 1 bo'lgan)
      let studentStartIdx = -1
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]?.values?.[0]?.effectiveValue?.numberValue === 1) {
          studentStartIdx = i
          break
        }
      }
      if (studentStartIdx === -1) continue

      const firstStudentRow = rows[studentStartIdx]
      const formulaCols = new Set<number>()
      const maxColCount = firstStudentRow?.values?.length || 0

      for (let col = 3; col < maxColCount; col++) {
        const cell = firstStudentRow?.values?.[col]
        if (cell?.userEnteredValue?.formulaValue) formulaCols.add(col)
      }

      // O'rtacha/Umumiy ustunlarini aniqlash
      let ortachaColIdx = -1
      let umumiyColIdx = -1
      for (let r = 0; r < studentStartIdx; r++) {
        const values = rows[r]?.values || []
        for (let c = 0; c < values.length; c++) {
          const val = (values[c]?.formattedValue || '').toLowerCase().replace(/\s/g, '')
          if (val.includes("ortacha") || val.includes("o'rtacha") || val.includes("o`rtacha") || val.includes("ўртача") || val.includes("сред")) {
            ortachaColIdx = c
          }
          if (val.includes("umumiy%") || (val.includes("umumiy") && val.includes("%")) || val.includes("умумий%")) {
            umumiyColIdx = c
          }
        }
      }

      const subjectLimit = ortachaColIdx !== -1 ? ortachaColIdx : (umumiyColIdx !== -1 ? umumiyColIdx - 2 : maxColCount)

      // Subject blocks
      const subjectBlocks: { start: number; end: number }[] = []
      let currentBlock: number[] = []

      for (let col = 3; col < subjectLimit; col++) {
        if (!formulaCols.has(col)) {
          currentBlock.push(col)
        } else {
          if (currentBlock.length > 0) {
            subjectBlocks.push({ start: currentBlock[0], end: currentBlock[currentBlock.length - 1] })
            currentBlock = []
          }
        }
      }
      if (currentBlock.length > 0) {
        subjectBlocks.push({ start: currentBlock[0], end: currentBlock[currentBlock.length - 1] })
      }

      // Har bir blok uchun fan nomini topish
      for (const block of subjectBlocks) {
        let subjectName = ''
        for (let r = 0; r < studentStartIdx; r++) {
          const rowVals = rows[r]?.values || []
          const v = (rowVals[block.start]?.formattedValue || '').trim()
          if (v) { subjectName = v; break }
          for (let col = block.start; col <= block.end; col++) {
            const v2 = (rowVals[col]?.formattedValue || '').trim()
            if (v2) { subjectName = v2; break }
          }
          if (subjectName) break
        }

        if (subjectName) {
          subjectName = cleanSubjectName(subjectName)
          const normalizedSub = subjectName.toLowerCase().replace(/\s/g, '')
          const normalizedClass = title.toLowerCase().replace(/\s/g, '')
          if (
            normalizedSub && 
            !normalizedSub.includes("umumiy") && 
            !normalizedSub.includes("ortacha") && 
            !normalizedSub.includes("o'rtacha") && 
            !normalizedSub.includes("o`rtacha")
          ) {
            discoveredEntries.set(`${normalizedClass}_${normalizedSub}`, { classOriginal: title, subjectOriginal: subjectName })
          }
        }
      }
    }

    // 5. Yangi ro'yxatni shakllantirish (mavjudlarni saqlab qolgan holda)
    const newRows: string[][] = [
      ["Sinf", "Fan nomi", "Telegram Username"]
    ]

    const processedKeys = new Set<string>()

    if (isOldFormat) {
      // Eski formatdan migratsiya
      for (const [key, info] of discoveredEntries.entries()) {
        const [, normSub] = key.split('_')
        const tg = existingTeachers.get(normSub) || ""
        newRows.push([info.classOriginal, info.subjectOriginal, tg])
        processedKeys.add(key)
      }
    } else {
      // Yangi format
      // Avval mavjudlarini qo'shamiz (ular o'chmasin va o'zgarishlar saqlansin)
      for (const [key, tg] of existingTeachers.entries()) {
        const discovered = discoveredEntries.get(key)
        if (discovered) {
          newRows.push([discovered.classOriginal, discovered.subjectOriginal, tg])
        } else {
          const [normClass, normSub] = key.split('_')
          newRows.push([normClass.toUpperCase(), normSub.toUpperCase(), tg])
        }
        processedKeys.add(key)
      }

      // Keyin yangi topilgan (jadvalda yo'q) sinf+fanlarni qo'shamiz
      for (const [key, info] of discoveredEntries.entries()) {
        if (!processedKeys.has(key)) {
          newRows.push([info.classOriginal, info.subjectOriginal, ""])
          processedKeys.add(key)
        }
      }
    }

    // 6. Google Sheets-ga yozish (alohida o'qituvchilar jadvaliga)
    const escapedTitle = teacherSheetTitle.replace(/'/g, "''")

    console.log("[FILL_TEACHERS] Eski kataklarni tozalash...")
    await sheets.spreadsheets.values.clear({
      spreadsheetId: teachersSpreadsheetId,
      range: `'${escapedTitle}'!A1:C200`,
    })

    console.log(`[FILL_TEACHERS] Yangi ma'lumotlarni yozish: ${newRows.length - 1} ta qator...`)
    await sheets.spreadsheets.values.update({
      spreadsheetId: teachersSpreadsheetId,
      range: `'${escapedTitle}'!A1:C${newRows.length}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: newRows,
      },
    })

    // Dizayn va formatlash (alohida o'qituvchilar jadvalida)
    console.log("[FILL_TEACHERS] Jadval dizaynini qo'llash...")
    const designRequests = [
      {
        updateSheetProperties: {
          properties: {
            sheetId: teacherSheetGid,
            gridProperties: {
              hideGridlines: false
            }
          },
          fields: "gridProperties.hideGridlines"
        }
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: teacherSheetGid,
            dimension: "COLUMNS",
            startIndex: 0,
            endIndex: 1
          },
          properties: { pixelSize: 80 },
          fields: "pixelSize"
        }
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: teacherSheetGid,
            dimension: "COLUMNS",
            startIndex: 1,
            endIndex: 2
          },
          properties: { pixelSize: 220 },
          fields: "pixelSize"
        }
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: teacherSheetGid,
            dimension: "COLUMNS",
            startIndex: 2,
            endIndex: 3
          },
          properties: { pixelSize: 220 },
          fields: "pixelSize"
        }
      },
      {
        repeatCell: {
          range: {
            sheetId: teacherSheetGid,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 3
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 31/255, green: 78/255, blue: 120/255 },
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              textFormat: {
                bold: true,
                fontSize: 11,
                foregroundColor: { red: 1.0, green: 1.0, blue: 1.0 },
                fontFamily: "Arial"
              }
            }
          },
          fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)"
        }
      },
      {
        repeatCell: {
          range: {
            sheetId: teacherSheetGid,
            startRowIndex: 1,
            endRowIndex: newRows.length,
            startColumnIndex: 0,
            endColumnIndex: 1
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              textFormat: { fontFamily: "Arial", fontSize: 10 }
            }
          },
          fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)"
        }
      },
      {
        repeatCell: {
          range: {
            sheetId: teacherSheetGid,
            startRowIndex: 1,
            endRowIndex: newRows.length,
            startColumnIndex: 1,
            endColumnIndex: 2
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "LEFT",
              verticalAlignment: "MIDDLE",
              textFormat: { fontFamily: "Arial", fontSize: 10 }
            }
          },
          fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)"
        }
      },
      {
        repeatCell: {
          range: {
            sheetId: teacherSheetGid,
            startRowIndex: 1,
            endRowIndex: newRows.length,
            startColumnIndex: 2,
            endColumnIndex: 3
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              textFormat: { fontFamily: "Arial", fontSize: 10 }
            }
          },
          fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)"
        }
      },
      {
        updateBorders: {
          range: {
            sheetId: teacherSheetGid,
            startRowIndex: 0,
            endRowIndex: newRows.length,
            startColumnIndex: 0,
            endColumnIndex: 3
          },
          top: { style: "SOLID", color: { red: 0.8, green: 0.8, blue: 0.8 } },
          bottom: { style: "SOLID", color: { red: 0.8, green: 0.8, blue: 0.8 } },
          left: { style: "SOLID", color: { red: 0.8, green: 0.8, blue: 0.8 } },
          right: { style: "SOLID", color: { red: 0.8, green: 0.8, blue: 0.8 } },
          innerHorizontal: { style: "SOLID", color: { red: 0.8, green: 0.8, blue: 0.8 } },
          innerVertical: { style: "SOLID", color: { red: 0.8, green: 0.8, blue: 0.8 } }
        }
      }
    ]

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: teachersSpreadsheetId,
      requestBody: {
        requests: designRequests as any[]
      }
    })

    const addedCount = newRows.length - 1 - (isOldFormat ? 0 : existingTeachers.size)
    sendJson(res, 200, {
      success: true,
      url: teachersSpreadsheetUrl,
      message: `O'qituvchilar varag'i alohida jadvalda yangilandi va dizayn qilindi! Jami ${newRows.length - 1} ta fan yozildi (shundan ${addedCount > 0 ? addedCount : 0} tasi yangi qo'shildi) ✅`
    })

  } catch (err: any) {
    console.error("Fill teachers error:", err)
    sendJson(res, 500, { error: err?.message || 'Noma\'lum xato' })
  }
}

const ALLOWED_ORIGINS = [
  'https://haftalik-beta.vercel.app',
  'http://localhost:5173',
  'http://localhost:4173',
]

async function apiMiddleware(req: any, res: any) {
  const origin = req.headers['origin'] || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

  const url = req.url || ''

  // GET /api/env — barcha .env o'qish
  if (url === '/env' && req.method === 'GET') {
    sendJson(res, 200, readEnv())
    return
  }

  // POST /api/env — bitta key saqlash
  if (url === '/env' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req))
    if (!body.key) { sendJson(res, 400, { error: 'Key required' }); return }
    const env = readEnv()
    env[body.key] = body.value
    writeEnv(env)
    sendJson(res, 200, { success: true })
    return
  }

  // POST /api/tozalash — baholarni tozalash + Telegramga link yuborish
  if (url === '/tozalash' && req.method === 'POST') {
    await handleTozalash(res)
    return
  }

  // POST /api/shanba — eng yuqori foizli o'quvchilarni yuborish
  if (url === '/shanba' && req.method === 'POST') {
    await handleShanba(res)
    return
  }

  // POST /api/barcha — har bir sheetni PNG + caption bilan yuborish
  if (url === '/barcha' && req.method === 'POST') {
    await handleBarcha(res)
    return
  }

  // POST /api/alohida — har bir sinfni o'z rang guruhiga yuborish
  if (url === '/alohida' && req.method === 'POST') {
    await handleAlohida(res)
    return
  }

  // POST /api/fill-teachers — o'qituvchilar varag'ini avtomatik to'ldirish
  if (url === '/fill-teachers' && req.method === 'POST') {
    await handleFillTeachers(res)
    return
  }



  // GET /api/userbot/status — statusni o'qish
  if (url === '/userbot/status' && req.method === 'GET') {
    try {
      const db = readDB()
      if (db.userbotSession) {
        sendJson(res, 200, {
          connected: true,
          phoneNumber: db.userbotSession.phoneNumber,
          apiId: db.userbotSession.apiId,
          session: db.userbotSession
        })
      } else {
        sendJson(res, 200, { connected: false })
      }
    } catch (err: any) {
      sendJson(res, 500, { error: err.message || String(err) })
    }
    return
  }

  // POST /api/userbot/connect — ulanish (tasdiqlash kodi so'rash)
  if (url === '/userbot/connect' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const { apiId, apiHash, phoneNumber } = body
      if (!apiId || !apiHash || !phoneNumber) {
        sendJson(res, 400, { error: "API ID, API Hash va Telefon raqami majburiy." })
        return
      }

      if (tempTelegramClient) {
        try { await tempTelegramClient.disconnect() } catch {}
        tempTelegramClient = null
      }

      tempApiId = parseInt(apiId)
      tempApiHash = apiHash.trim()
      tempPhoneNumber = phoneNumber.trim()

      const session = new StringSession("")
      tempTelegramClient = new TelegramClient(session, tempApiId, tempApiHash, {
        connectionRetries: 5,
      })

      console.log(`[USERBOT] Telegramga ulanmoqda (${tempPhoneNumber})...`)
      await tempTelegramClient.connect()

      console.log(`[USERBOT] Tasdiqlash kodi so'ralmoqda...`)
      const result = await tempTelegramClient.sendCode({
        apiId: tempApiId,
        apiHash: tempApiHash,
      }, tempPhoneNumber)

      tempPhoneCodeHash = result.phoneCodeHash
      console.log(`[USERBOT] Tasdiqlash kodi muvaffaqiyatli so'raldi.`)
      sendJson(res, 200, { success: true, message: "Kod yuborildi. Iltimos, Telegramingizni tekshiring." })
    } catch (err: any) {
      console.error(`[USERBOT] Ulanishda xato:`, err.message)
      sendJson(res, 500, { error: err.message || String(err) })
    }
    return
  }

  // POST /api/userbot/verify — kodni tekshirish
  if (url === '/userbot/verify' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const { code, password } = body
      if (!code) {
        sendJson(res, 400, { error: "Tasdiqlash kodi kiritilishi shart." })
        return
      }

      if (!tempTelegramClient) {
        sendJson(res, 400, { error: "Ulanish sessiyasi topilmadi. Avval kod yuboring." })
        return
      }

      console.log(`[USERBOT] Kod tekshirilmoqda: ${code}`)
      try {
        await tempTelegramClient.invoke(
          new Api.auth.SignIn({
            phoneNumber: tempPhoneNumber,
            phoneCodeHash: tempPhoneCodeHash,
            phoneCode: code,
          })
        )
      } catch (signInErr: any) {
        if (signInErr.message.includes("SESSION_PASSWORD_NEEDED")) {
          if (!password) {
            sendJson(res, 200, { success: false, passwordRequired: true, message: "Ikki bosqichli parol (2FA) talab etiladi." })
            return
          }
          console.log(`[USERBOT] 2FA parol bilan kirishga urinish...`)
          await tempTelegramClient.signInWithPassword(
            {
              apiId: tempApiId,
              apiHash: tempApiHash,
            },
            {
              password: async () => password,
              onError: (err: any) => {
                console.error("[USERBOT] signInWithPassword error:", err.message || err)
                throw err
              }
            }
          )
        } else {
          throw signInErr
        }
      }

      const sessionStr = tempTelegramClient.session.save() as string
      const db = readDB()
      const sessionData = {
        apiId: tempApiId,
        apiHash: tempApiHash,
        phoneNumber: tempPhoneNumber,
        sessionStr: sessionStr
      }
      db.userbotSession = sessionData
      writeDB(db)

      console.log(`[USERBOT] Muvaffaqiyatli ulandi!`)
      tempTelegramClient = null
      tempPhoneNumber = ""
      tempPhoneCodeHash = ""
      tempApiId = 0
      tempApiHash = ""

      sendJson(res, 200, { success: true, message: "Telegram profilingiz muvaffaqiyatli ulandi!", session: sessionData })
    } catch (err: any) {
      console.error(`[USERBOT] Kod tasdiqlashda xato:`, err.message)
      sendJson(res, 500, { error: err.message || String(err) })
    }
    return
  }

  // POST /api/userbot/disconnect — aloqani uzish
  if (url === '/userbot/disconnect' && req.method === 'POST') {
    try {
      const db = readDB()
      if (db.userbotSession) {
        try {
          const session = new StringSession(db.userbotSession.sessionStr)
          const client = new TelegramClient(session, db.userbotSession.apiId, db.userbotSession.apiHash, { connectionRetries: 1 })
          await client.connect()
          await client.invoke(new Api.auth.LogOut())
        } catch (e) {}

        delete db.userbotSession
        writeDB(db)
      }
      sendJson(res, 200, { success: true, message: "Ulanish uzildi." })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message || String(err) })
    }
    return
  }

  // POST /api/userbot/restore — sessiyani qayta yuklash
  if (url === '/userbot/restore' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const { session } = body
      if (!session) {
        sendJson(res, 400, { error: "Sessiya yuborilmadi." })
        return
      }

      // Validate session before storing it
      try {
        const client = new TelegramClient(
          new StringSession(session.sessionStr),
          parseInt(session.apiId),
          session.apiHash,
          { connectionRetries: 1 }
        )
        await client.connect()
        await client.getDialogs({ limit: 1 })
        await client.disconnect()
      } catch (authErr: any) {
        const errMsg = String(authErr.message || authErr)
        if (
          errMsg.includes("AUTH_KEY_UNREGISTERED") || 
          errMsg.includes("USER_DEACTIVATED") || 
          errMsg.includes("SESSION_REVOKED") || 
          errMsg.includes("SESSION_EXPIRED")
        ) {
          sendJson(res, 200, { success: false, error: "AUTH_KEY_UNREGISTERED", message: "Sessiya muddati o'tgan yoki bekor qilingan." })
          return
        }
      }

      const db = readDB()
      db.userbotSession = session
      writeDB(db)
      sendJson(res, 200, { success: true, message: "Telegram userbot ulanishi tiklandi." })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message || String(err) })
    }
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

// ─── Vite config ───────────────────────────────────────────────────────────
export default defineConfig({
  preview: {
    allowedHosts: true,
    cors: true,
  },
  plugins: [
    react(),
    {
      name: 'api',
      configureServer(server) {
        server.middlewares.use('/api', apiMiddleware)
      },
      configurePreviewServer(server) {
        // Global CORS middleware — runs before static file serving
        server.middlewares.use((req: any, res: any, next: any) => {
          const origin = req.headers['origin'] || ''
          if (ALLOWED_ORIGINS.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin)
          } else {
            res.setHeader('Access-Control-Allow-Origin', '*')
          }
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          res.setHeader('Vary', 'Origin')
          if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
          next()
        })
        server.middlewares.use('/api', apiMiddleware)
      }
    },
  ],
})
