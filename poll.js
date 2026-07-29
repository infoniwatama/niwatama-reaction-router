// Slackリアクション → Notion反映（ポーリング版・GitHub Actionsで5分ごと・PCオフでも動く）
// #yt_editor の依頼スレッドを走査し、トリガー絵文字が付いた(メッセージ×絵文字)のうち未処理のものを処理する。
// 冪等性: 処理済み(ts:reaction)を state/processed.json に記録（GH Actionsがコミットバック）。
//         → 同じリアクションを二度処理しない＝一度進めた状態を巻き戻さない。
// 使い方: node poll.js          (dry-run=表示のみ・state変更なし)
//         node poll.js --apply  (Notion反映＋state更新)
// 必要env: SLACK_BOT_TOKEN, NOTION_TOKEN
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { WebClient } from '@slack/web-api';

const APPLY = process.argv.includes('--apply');
const CH = 'C0BC0PH7AMU';                 // #yt_editor
const DB = '386781c3-31f8-8075-9e05-fd3757e97822'; // タスク管理ツール
const LOOKBACK_DAYS = 5;                   // 過去何日分のスレッドを見るか
const STATE = new URL('./state/processed.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const EMOJI_THUMB = 'samune', EMOJI_DONE = 'kanryou', EMOJI_VER1 = 'kakuninn', EMOJI_POSTED = 'sumi', EMOJI_REVISE = 'syuusei', EMOJI_CONFIRM = 'robot_face';
const TRIGGERS = [EMOJI_THUMB, EMOJI_DONE, EMOJI_VER1, EMOJI_POSTED, EMOJI_REVISE];

// --- トークン（env優先・ローカルは .claude.json フォールバック） ---
let NT = process.env.NOTION_TOKEN;
let BOT = process.env.SLACK_BOT_TOKEN;
if (!NT) { try { const c = JSON.parse(readFileSync(process.env.USERPROFILE + '/.claude.json', 'utf8')); NT = c.projects['C:/Users/souro/youtube-cc-company/.company'].mcpServers.notionhq.env.NOTION_TOKEN; } catch {} }
if (!BOT) { try { const e = readFileSync(process.env.USERPROFILE + '/dept-orchestrator/.env', 'utf8'); BOT = (e.match(/SLACK_BOT_TOKEN=(.+)/) || [])[1]?.trim(); } catch {} }
if (!NT || !BOT) { console.error('NOTION_TOKEN / SLACK_BOT_TOKEN が無い'); process.exit(1); }
const NH = { Authorization: 'Bearer ' + NT, 'Notion-Version': '2022-06-28' };
const NHJ = { ...NH, 'Content-Type': 'application/json' };
const slack = new WebClient(BOT);

const reYT = /https?:\/\/(?:youtu\.be\/|(?:www\.)?youtube\.com\/(?:shorts\/|watch\?v=|live\/))([\w-]{6,})/;
const reFIO = /https?:\/\/(?:f\.io|[a-z0-9.]*frame\.io)\/[^\s|>]+/;

async function queryAll() {
  let all = [], cursor;
  do {
    const r = await fetch('https://api.notion.com/v1/databases/' + DB + '/query', { method: 'POST', headers: NHJ, body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }) });
    const j = await r.json(); all = all.concat(j.results || []); cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return all;
}
const nm = p => p.properties['タスク名'].title.map(x => x.plain_text).join('');
const reqLink = p => p.properties['Slack依頼リンク']?.url || '';
const tsToPid = ts => 'p' + ts.replace('.', '');
function extractUrl(msg) {
  const t = msg.text || ''; const y = t.match(reYT); if (y) return 'https://youtu.be/' + y[1];
  for (const a of (msg.attachments || [])) if (a.service_name === 'Frame.io' && a.from_url) return a.from_url;
  const f = t.match(reFIO); if (f) return f[0]; return null;
}
const extractImage = msg => (msg.files || []).find(f => (f.mimetype || '').startsWith('image')) || null;

async function uploadImageToNotion(f) {
  const buf = Buffer.from(await (await fetch(f.url_private, { headers: { Authorization: 'Bearer ' + BOT } })).arrayBuffer());
  const cr = await (await fetch('https://api.notion.com/v1/file_uploads', { method: 'POST', headers: NHJ, body: JSON.stringify({ mode: 'single_part', filename: f.name, content_type: f.mimetype }) })).json();
  const fd = new FormData(); fd.append('file', new Blob([buf], { type: f.mimetype }), f.name);
  const snd = await (await fetch('https://api.notion.com/v1/file_uploads/' + cr.id + '/send', { method: 'POST', headers: NH, body: fd })).json();
  if (snd.status !== 'uploaded') throw new Error('upload failed');
  return { id: cr.id, name: f.name };
}
const patch = (id, props) => fetch('https://api.notion.com/v1/pages/' + id, { method: 'PATCH', headers: NHJ, body: JSON.stringify({ properties: props }) });

// 1リアクションを処理（msg/task は呼び出し側が用意）
async function act(reaction, msg, task) {
  const status = task.properties['ステータス'].status?.name || '';
  if (reaction === EMOJI_THUMB) {
    const img = extractImage(msg); if (!img) return '画像なし';
    const already = (task.properties['サムネ']?.files || []).map(f => f.name);
    const props = {};
    if (!already.includes(img.name)) { const up = await uploadImageToNotion(img); props['サムネ'] = { files: [{ type: 'file_upload', file_upload: { id: up.id }, name: up.name }] }; }
    if (status === 'サムネ待ち') props['ステータス'] = { status: { name: '投稿待ち' } };
    if (Object.keys(props).length) await patch(task.id, props);
    return 'サムネ' + (status === 'サムネ待ち' ? '→投稿待ち' : '(status維持)');
  }
  if (reaction === EMOJI_DONE) {
    const url = extractUrl(msg);
    const kind = (task.properties['タスクの種類']?.multi_select || []).map(x => x.name).join('');
    const isLong = /ロング/.test(kind) || /ロング/.test(nm(task));
    const props = { 'ステータス': { status: { name: isLong ? 'サムネ待ち' : '投稿待ち' } } };
    if (url) props['完パケURL'] = { url };
    await patch(task.id, props);
    return 'ステータス=' + (isLong ? 'サムネ待ち' : '投稿待ち') + (url ? ' 完パケ有' : '');
  }
  if (reaction === EMOJI_VER1) {
    const url = extractUrl(msg); const props = { 'ステータス': { status: { name: '確認待ち' } } };
    if (url) props['修正前URL'] = { url };
    await patch(task.id, props); return '確認待ち' + (url ? ' 修正前有' : '');
  }
  if (reaction === EMOJI_POSTED) { await patch(task.id, { 'ステータス': { status: { name: '投稿済み' } } }); return '投稿済み'; }
  if (reaction === EMOJI_REVISE) { await patch(task.id, { 'ステータス': { status: { name: '修正中' } } }); return '修正中'; }
}

async function main() {
  const processed = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const all = await queryAll();
  const taskByPid = {};
  for (const p of all) { const l = reqLink(p); if (l) { const m = l.match(/\/p(\d{10})(\d{6})/); if (m) taskByPid['p' + m[1] + m[2]] = p; } }
  const oldest = ((Date.now() / 1000) - LOOKBACK_DAYS * 86400).toFixed(6);
  const hist = await slack.conversations.history({ channel: CH, oldest, limit: 200 });
  let changed = false, acted = 0, scanned = 0;
  for (const parent of (hist.messages || [])) {
    const pid = 'p' + parent.ts.replace('.', '');
    const task = taskByPid[pid];
    if (!task) continue; // 追跡タスクのスレッドのみ
    // スレッド全メッセージ（親＋返信）
    let msgs = [parent];
    if (parent.reply_count) { try { msgs = (await slack.conversations.replies({ channel: CH, ts: parent.ts, limit: 100 })).messages || [parent]; } catch {} }
    for (const msg of msgs) {
      for (const rx of (msg.reactions || [])) {
        if (!TRIGGERS.includes(rx.name)) continue;
        scanned++;
        const key = msg.ts + ':' + rx.name;
        if (processed[key]) continue; // 既処理＝スキップ（冪等）
        console.log((APPLY ? '' : '[DRY] ') + '処理: ' + nm(task) + ' ← :' + rx.name + ': (msg ' + msg.ts + ')');
        if (APPLY) {
          try {
            const summary = await act(rx.name, msg, task);
            processed[key] = new Date().toISOString();
            changed = true; acted++;
            try { await slack.reactions.add({ channel: CH, timestamp: msg.ts, name: EMOJI_CONFIRM }); } catch {}
            try { await slack.chat.postMessage({ channel: CH, thread_ts: parent.ts, text: ':robot_face: *' + nm(task) + '* → ' + summary }); } catch {}
            console.log('   ✓ ' + summary);
          } catch (e) { console.log('   ✗ ' + e.message); }
        }
      }
    }
  }
  console.log((APPLY ? 'APPLY' : 'DRY') + ' 完了: 未処理トリガー=' + scanned + ' 処理=' + acted);
  if (APPLY && changed) { writeFileSync(STATE, JSON.stringify(processed, null, 0)); console.log('state更新: ' + Object.keys(processed).length + '件'); }
}
main().catch(e => { console.error('failed:', e); process.exit(1); });
