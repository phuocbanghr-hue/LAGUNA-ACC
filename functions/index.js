const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

const GMAIL_USER = defineString("GMAIL_USER");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const REMINDER_TO = defineString("REMINDER_TO", {default: "LP-Accountant@lagunalangco.com"});
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", {default: "claude-sonnet-5-5"});

const TZ = "Asia/Ho_Chi_Minh";
const REGION = "asia-southeast1";

function nextDue(c, paid) {
  const a = (c.installments || []).filter(i => i.dueDate).sort((x, y) => x.dueDate.localeCompare(y.dueDate));
  if (!a.length) return c.dueDate || "";
  let cum = 0;
  for (const i of a) { cum += Number(i.amount) || 0; if (paid < cum) return i.dueDate; }
  return a[a.length - 1].dueDate;
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[m]));
const fmt = n => Number(n || 0).toLocaleString("vi-VN") + " ₫";
const todayStr = () => new Date().toLocaleDateString("en-CA", {timeZone: TZ});
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const fmtDate = d => d.split("-").reverse().join("/");

// Cấu hình chỉnh được ngay trên web (settings/automation), không cần deploy lại
async function getSettings() {
  const d = (await db.doc("settings/automation").get()).data() || {};
  return {
    enabled: d.enabled !== false,
    remindDays: Number(d.remindDays) || 7,
    repeatOverdueDays: d.repeatOverdueDays === 0 ? 0 : (Number(d.repeatOverdueDays) || 3),
    reminderTo: (d.reminderTo || "").trim() || REMINDER_TO.value(),
    emailPartners: d.emailPartners === true,
  };
}

// Gom hợp đồng cần nhắc. Quá hạn sẽ được nhắc lặp lại mỗi N ngày cho đến khi thu đủ.
async function runReminder({force = false} = {}) {
  const S = await getSettings();
  if (!S.enabled && !force) { console.log("Tự động nhắc đang tắt."); return 0; }
  const today = todayStr();
  const snap = await db.collection("contracts").get();
  const due = [];
  snap.forEach(doc => {
    const c = doc.data();
    const paid = (c.depositPaid || 0) + (c.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const remaining = (c.depositAmount || 0) - paid;
    const dueDate = nextDue(c, paid);
    if (remaining <= 0 || !dueDate) return;
    const days = daysBetween(dueDate, today);
    if (days > S.remindDays) return;
    const sentAgo = c.reminderSentAt ? daysBetween(today, c.reminderSentAt) : 999;
    const first = c.reminderSentFor !== dueDate;
    const repeat = days < 0 && S.repeatOverdueDays > 0 && sentAgo >= S.repeatOverdueDays;
    if (force || first || repeat) due.push({id: doc.id, ...c, dueDate, days, remaining});
  });

  if (!due.length) { console.log("Không có hợp đồng cần nhắc."); await db.doc("settings/automation").set({lastRun: today, lastCount: 0}, {merge: true}); return 0; }
  due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const td = "padding:6px;border:1px solid #ddd";
  const rows = due.map(c => `<tr>
    <td style="${td}">${esc(c.partner)}</td><td style="${td}">${esc(c.contractNo)}</td>
    <td style="${td};text-align:right">${fmt(c.depositAmount)}</td><td style="${td};text-align:right">${fmt(c.remaining)}</td>
    <td style="${td}">${fmtDate(c.dueDate)}</td>
    <td style="${td};color:${c.days < 0 ? "#d64545" : "#e08a00"}">${c.days < 0 ? `Quá hạn ${-c.days} ngày` : `Còn ${c.days} ngày`}</td></tr>`).join("");
  const total = due.reduce((s, c) => s + c.remaining, 0);
  const html = `<div style="font-family:Arial,sans-serif">
    <h2 style="color:#00a19a">Nhắc hạn thanh toán đặt cọc hợp đồng</h2>
    <p>Có <b>${due.length}</b> hợp đồng cần đặt cọc trong ${S.remindDays} ngày tới hoặc đã quá hạn, tổng còn thiếu <b>${fmt(total)}</b>:</p>
    <table style="border-collapse:collapse;font-size:14px"><thead><tr style="background:#eaf6f5">
      ${["Đối tác", "Số HĐ", "Cọc phải đóng", "Còn thiếu", "Hạn cọc", "Trạng thái"].map(h => `<th style="${td}">${h}</th>`).join("")}
    </tr></thead><tbody>${rows}</tbody></table>
    <p style="color:#666;font-size:12px">Email tự động từ hệ thống theo dõi đặt cọc - Laguna Lăng Cô Sustainability.</p></div>`;

  const transporter = nodemailer.createTransport({service: "gmail", auth: {user: GMAIL_USER.value(), pass: GMAIL_APP_PASSWORD.value()}});
  await transporter.sendMail({
    from: `Laguna Sustainability <${GMAIL_USER.value()}>`,
    to: S.reminderTo,
    subject: `[Nhắc hạn] ${due.length} hợp đồng cần đặt cọc (còn thiếu ${fmt(total)})`,
    html,
  });

  // Tự gửi email nhắc tới đối tác (chỉ khi bật trong cài đặt, không gửi khi bấm "Gửi nhắc ngay")
  if (S.emailPartners && !force) {
    for (const c of due.filter(x => x.partnerEmail)) {
      await transporter.sendMail({
        from: `Laguna Sustainability <${GMAIL_USER.value()}>`, to: c.partnerEmail, cc: S.reminderTo,
        subject: `[Laguna] Nhắc thanh toán tiền đặt cọc hợp đồng ${c.contractNo}`,
        html: `<div style="font-family:Arial,sans-serif"><p>Kính gửi Quý đối tác ${esc(c.partner)},</p>
          <p>Theo hợp đồng số <b>${esc(c.contractNo)}</b>, khoản đặt cọc còn thiếu <b>${fmt(c.remaining)}</b> có hạn thanh toán ngày <b>${fmtDate(c.dueDate)}</b> (${c.days < 0 ? `đã quá hạn ${-c.days} ngày` : `còn ${c.days} ngày`}).</p>
          <p>Kính mong Quý đối tác sắp xếp thanh toán. Nếu đã thanh toán, vui lòng bỏ qua email này.</p>
          <p>Trân trọng,<br>Laguna Lăng Cô Sustainability</p></div>`,
      });
    }
  }

  const batch = db.batch();
  due.forEach(c => batch.update(db.collection("contracts").doc(c.id), {reminderSentFor: c.dueDate, reminderSentAt: today}));
  batch.set(db.doc("settings/automation"), {lastRun: today, lastCount: due.length}, {merge: true});
  await batch.commit();
  console.log(`Đã gửi nhắc ${due.length} hợp đồng.`);
  return due.length;
}

exports.dailyDepositReminder = onSchedule(
    {schedule: "every day 08:00", timeZone: TZ, region: REGION, secrets: [GMAIL_APP_PASSWORD]},
    async () => { await runReminder(); },
);

// Nút "Gửi nhắc ngay" trên web
exports.sendReminderNow = onCall(
    {region: REGION, secrets: [GMAIL_APP_PASSWORD]},
    async (req) => {
      if (!req.auth) throw new HttpsError("unauthenticated", "Vui lòng đăng nhập.");
      return {sent: await runReminder({force: true})};
    },
);

// ---- Gọi Claude đọc file ----
async function askClaude(files, prompt) {
  if (!Array.isArray(files) || !files.length || files.length > 12) throw new HttpsError("invalid-argument", "Cần 1–12 file.");
  const content = files.map(f => f.mediaType === "application/pdf" ?
    {type: "document", source: {type: "base64", media_type: "application/pdf", data: f.data}} :
    {type: "image", source: {type: "base64", media_type: "image/jpeg", data: f.data}});
  content.push({type: "text", text: prompt});
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY.value(), "anthropic-version": "2023-06-01"},
    body: JSON.stringify({model: CLAUDE_MODEL.value(), max_tokens: 4000, messages: [{role: "user", content}]}),
  });
  if (!res.ok) {
    console.error("Anthropic API", res.status, await res.text());
    throw new HttpsError("internal", "Không gọi được dịch vụ đọc file (" + res.status + ").");
  }
  const out = await res.json();
  const text = (out.content || []).map(b => b.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new HttpsError("internal", "Không đọc được dữ liệu từ file.");
  try { return JSON.parse(m[0]); } catch (e) { throw new HttpsError("internal", "Kết quả đọc không hợp lệ, thử lại."); }
}

const CONTRACT_PROMPT = `Đây là các trang của một hợp đồng/thỏa thuận mà Laguna (Việt Nam) là Bên A. Trích xuất thông tin và CHỈ trả về một đối tượng JSON, không kèm giải thích hay markdown:
{"partner": tên công ty của Bên B (đối tác, không phải Laguna),
 "contractNo": số hợp đồng ("Số/No."),
 "totalValue": tổng giá trị hợp đồng bằng VND (số nguyên) hoặc null nếu không nêu,
 "depositAmount": tổng tiền đặt cọc bằng VND (số nguyên) hoặc null,
 "installments": [{"dueDate": "YYYY-MM-DD", "amount": số nguyên VND}] các đợt thanh toán cọc theo thứ tự, mảng rỗng nếu không có,
 "note": tóm tắt 1 câu điều khoản quan trọng (ví dụ số lượt chơi cam kết) hoặc ""}
Quy tắc: chỉ ghi những gì đọc được rõ ràng, nếu không chắc thì để null; ngày theo định dạng YYYY-MM-DD; số tiền là số nguyên không có dấu phân cách.`;

const BANK_PROMPT = `Đây là sao kê ngân hàng / giấy báo có. Trích xuất CHỈ các giao dịch TIỀN VÀO (ghi có) và trả về duy nhất một đối tượng JSON, không kèm giải thích hay markdown:
{"transactions": [{"date": "YYYY-MM-DD", "amount": số nguyên VND, "description": nội dung chuyển khoản nguyên văn, "ref": mã giao dịch/số chứng từ hoặc ""}]}
Quy tắc: bỏ qua giao dịch tiền ra; không đoán những gì không đọc rõ; số tiền là số nguyên không có dấu phân cách.`;

exports.extractContract = onCall(
    {region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB"},
    async (req) => {
      if (!req.auth) throw new HttpsError("unauthenticated", "Vui lòng đăng nhập.");
      return askClaude(req.data && req.data.files, CONTRACT_PROMPT);
    },
);

// Đối soát sao kê: trả về danh sách giao dịch tiền vào để web tự khớp với hợp đồng
exports.extractPayments = onCall(
    {region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB"},
    async (req) => {
      if (!req.auth) throw new HttpsError("unauthenticated", "Vui lòng đăng nhập.");
      return askClaude(req.data && req.data.files, BANK_PROMPT);
    },
);
