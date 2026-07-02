import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { pdfToPng } from 'pdf-to-png-converter'
import sharp from 'sharp'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const ENV_PATH = path.resolve(__dirname, '.env')

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

    // 1. Spreadsheetni grid data bilan o'qish
    //    includeGridData=true → har bir katakcha formula yoki qiymat ekanini bilish uchun
    const spreadsheetInfo = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: true,
    })

    const clearRanges: string[] = []

    for (const sheet of spreadsheetInfo.data.sheets || []) {
      const sheetTitle = sheet.properties?.title || ''
      const rows = sheet.data?.[0]?.rowData || []

      // ── O'quvchi ma'lumotlari boshlanadigan qatorni topish ──────────────
      // A ustunida 1 bo'lgan birinchi qator = birinchi o'quvchi qatori
      // Undan oldingi qatorlar = sarlavha (fan nomlari, 1-10/11-20/21-30)
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
      // Birinchi o'quvchi qatoridagi D+ ustunlarni tekshiramiz:
      // Foizi, O'rtacha, Jarima, Umumiy % = formulali → SAQLANADI
      // Qo'lda kiritilgan baholar = formula yo'q  → TOZALANADI
      const firstStudentRow = rows[studentStartIdx]
      const formulaCols = new Set<number>()
      const maxCol = firstStudentRow?.values?.length || 0

      for (let col = 3; col < maxCol; col++) { // col 3 = D (A=0, B=1, C=2)
        const cell = firstStudentRow?.values?.[col]
        if (cell?.userEnteredValue?.formulaValue) {
          formulaCols.add(col)
        }
      }

      // ── Tozalanadigan range larni qurish ─────────────────────────────────
      // A(0)=№, B(1)=Familiya, C(2)=Ism — o'tkaziladi
      // Formula ustunlari — o'tkaziladi
      // Ketma-ket non-formula ustunlarni bitta range sifatida birlashtirish
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
        await userbot.disconnect()
        messageSent = true
      } catch (err: any) {
        console.error(`[USERBOT] Xabar yuborishda xato: ${err.message}. Bot orqali yuboriladi...`)
        await handleUserbotError(err)
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

    // Visible sheetlarni aniqlash (yashirin bo'lmagan varaqlar)
    const visibleSheets = sheetList.filter(s => !s.properties?.hidden)

    let sentCount = 0
    const errors: string[] = []

    console.log(`Jami aniqlangan sinflar: ${visibleSheets.length}. Ularni rasmga aylantirib yuborish boshlanmoqda...`)

    for (const sheet of visibleSheets) {
      const gid = sheet.properties?.sheetId
      const title = sheet.properties?.title || `Sheet${gid}`

      // 2. Har bir sheet uchun alohida, minimal field mask bilan data olish
      const sheetDataRes = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${title}'!A1:Z500`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values(formattedValue,effectiveValue,userEnteredValue.formulaValue)',
      })
      const rows = sheetDataRes.data.sheets?.[0]?.data?.[0]?.rowData || []

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

          if (isOrtacha) {
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

      const tempUpdates: { rowIndex: number; startCol: number; endCol: number }[] = []

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
          for (let i = studentStartIdx; i < rows.length; i++) {
            const rowNum = rows[i]?.values?.[0]?.effectiveValue?.numberValue
            if (typeof rowNum !== 'number' || rowNum <= 0) continue

            // ortacha qatoriga yetganda to'xtatish
            if (ortachaRowIdx !== -1 && i >= ortachaRowIdx) break

            // 1. O'quvchi barcha fanlardan qatnashmaganligini tekshirish
            let allSubjectsEmpty = true
            for (const block of subjectBlocks) {
              if (!isBlockEmpty(i, block)) {
                allSubjectsEmpty = false
                break
              }
            }

            if (allSubjectsEmpty) {
              // Butunlay qatnashmagan: birinchi fanning boshlanishidan to jadval oxirigacha (Umumiy %) birlashtiradi
              tempUpdates.push({
                rowIndex: i,
                startCol: subjectBlocks[0].start,
                endCol: colLimit
              })
            } else {
              // Ayrim fanlarga qatnashmagan: faqat o'sha fanning o'zini (baho ustunlari + Foizi) birlashtiradi
              for (const block of subjectBlocks) {
                if (isBlockEmpty(i, block)) {
                  tempUpdates.push({
                    rowIndex: i,
                    startCol: block.start,
                    endCol: block.end + 1
                  })
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
                            italic: true,
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
            await sheetsWrite.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: {
                requests: unmergeRequests
              }
            })
            // 2. Clear cell values
            await sheetsWrite.spreadsheets.values.batchClear({
              spreadsheetId,
              requestBody: {
                ranges: tempUpdates.map(u => `'${title}'!${colLetter(u.startCol)}${u.rowIndex + 1}`)
              }
            })
            console.log(`${title}: "qatnashmadi" yozuvlari o'chirildi va kataklar qayta tiklandi`)
          } catch (restoreErr: any) {
            console.error(`${title}: Qayta tiklashda xato:`, restoreErr?.message)
          }
        }
      }

      // ── 4. Telegramga yuborish ───────────────────────────────────────────
      if (success && imageBuffer) {
        let sentViaUserbot = false
        const userbot = await getUserbotClient()
        if (userbot) {
          try {
            console.log(`[USERBOT] Sinf ${title} rasmi yuborilmoqda...`)
            await connectUserbot(userbot)

            const { CustomFile } = await import("telegram/client/uploads.js")
            const toSend = new CustomFile(`${title}.png`, imageBuffer.length, "", imageBuffer)

            await userbot.sendFile(groupId3, {
              file: toSend,
              caption: CAPTION
            })

            await userbot.disconnect()
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
    sendJson(res, 200, { success: true, message: `${sentCount} ta sinf yuborildi ✅` })
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || 'Noma\'lum xato' })
  }
}

// ─── API Middleware ────────────────────────────────────────────────────────
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
