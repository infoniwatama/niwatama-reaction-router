// 初回キャッチアップ: 既存のスタンプで「まだ反映されていない(現状より前に進む)」ものだけ適用する。
// advance-only（ステータスは前進のみ・巻き戻さない）＋URL/サムネは不足時のみ補完。
// 最後に、走査した全(ts:reaction)を state/processed.json に記録＝以降のcronが再処理しない。
// 使い方: node catchup.js  (dry) / node catchup.js --apply
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { WebClient } from '@slack/web-api';

const APPLY = process.argv.includes('--apply');
const CH = 'C0BC0PH7AMU', DB = '386781c3-31f8-8075-9e05-fd3757e97822', LOOKBACK_DAYS = 7;
const STATE = new URL('./state/processed.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let NT = process.env.NOTION_TOKEN, BOT = process.env.SLACK_BOT_TOKEN;
if (!NT) { try { NT = JSON.parse(readFileSync(process.env.USERPROFILE + '/.claude.json', 'utf8')).projects['C:/Users/souro/youtube-cc-company/.company'].mcpServers.notionhq.env.NOTION_TOKEN; } catch {} }
if (!BOT) { try { BOT = (readFileSync(process.env.USERPROFILE + '/dept-orchestrator/.env', 'utf8').match(/SLACK_BOT_TOKEN=(.+)/) || [])[1]?.trim(); } catch {} }
const NH = { Authorization: 'Bearer ' + NT, 'Notion-Version': '2022-06-28' }, NHJ = { ...NH, 'Content-Type': 'application/json' };
const slack = new WebClient(BOT);
const RANK = { '未着手': 0, '進行中': 1, '確認待ち': 2, '修正中': 2, 'サムネ待ち': 3, '投稿待ち': 4, '完了': 4, '投稿済み': 5 };
const reYT = /https?:\/\/(?:youtu\.be\/|(?:www\.)?youtube\.com\/(?:shorts\/|watch\?v=|live\/))([\w-]{6,})/;
const reFIO = /https?:\/\/(?:f\.io|[a-z0-9.]*frame\.io)\/[^\s|>]+/;

async function queryAll() { let a = [], c; do { const r = await fetch('https://api.notion.com/v1/databases/' + DB + '/query', { method: 'POST', headers: NHJ, body: JSON.stringify(c ? { page_size: 100, start_cursor: c } : { page_size: 100 }) }); const j = await r.json(); a = a.concat(j.results || []); c = j.has_more ? j.next_cursor : undefined; } while (c); return a; }
const nm = p => p.properties['タスク名'].title.map(x => x.plain_text).join('');
const reqLink = p => p.properties['Slack依頼リンク']?.url || '';
const urlOf = m => { const t = m.text || ''; const y = t.match(reYT); if (y) return 'https://youtu.be/' + y[1]; for (const a of (m.attachments || [])) if (a.service_name === 'Frame.io' && a.from_url) return a.from_url; const f = t.match(reFIO); return f ? f[0] : null; };
const imgOf = m => (m.files || []).find(f => (f.mimetype || '').startsWith('image')) || null;
async function upImg(f) { const buf = Buffer.from(await (await fetch(f.url_private, { headers: { Authorization: 'Bearer ' + BOT } })).arrayBuffer()); const cr = await (await fetch('https://api.notion.com/v1/file_uploads', { method: 'POST', headers: NHJ, body: JSON.stringify({ mode: 'single_part', filename: f.name, content_type: f.mimetype }) })).json(); const fd = new FormData(); fd.append('file', new Blob([buf], { type: f.mimetype }), f.name); const snd = await (await fetch('https://api.notion.com/v1/file_uploads/' + cr.id + '/send', { method: 'POST', headers: NH, body: fd })).json(); if (snd.status !== 'uploaded') throw new Error('up fail'); return { id: cr.id, name: f.name }; }

async function main() {
  const all = await queryAll();
  const byPid = {}; for (const p of all) { const m = reqLink(p).match(/\/p(\d{10})(\d{6})/); if (m) byPid['p' + m[1] + m[2]] = p; }
  const oldest = ((Date.now() / 1000) - LOOKBACK_DAYS * 86400).toFixed(6);
  const hist = await slack.conversations.history({ channel: CH, oldest, limit: 200 });
  // タスクごとに: 反応集約 → 目標status + URL/img候補、走査キー
  const agg = {}; const stateKeys = [];
  for (const parent of (hist.messages || [])) {
    const task = byPid['p' + parent.ts.replace('.', '')]; if (!task) continue;
    let msgs = [parent]; if (parent.reply_count) { try { msgs = (await slack.conversations.replies({ channel: CH, ts: parent.ts, limit: 100 })).messages || [parent]; } catch {} }
    const kind = (task.properties['タスクの種類']?.multi_select || []).map(x => x.name).join(''); const isLong = /ロング/.test(kind) || /ロング/.test(nm(task));
    const a = agg[task.id] || (agg[task.id] = { task, target: null, kanpake: null, shusei: null, img: null });
    for (const m of msgs) for (const rx of (m.reactions || [])) {
      if (!['samune', 'kanryou', 'kakunin', 'sumi'].includes(rx.name)) continue;
      stateKeys.push(m.ts + ':' + rx.name);
      let tgt = null;
      if (rx.name === 'kakunin') { tgt = '確認待ち'; if (urlOf(m)) a.shusei = urlOf(m); }
      else if (rx.name === 'kanryou') { tgt = isLong ? 'サムネ待ち' : '投稿待ち'; if (urlOf(m)) a.kanpake = urlOf(m); }
      else if (rx.name === 'samune') { tgt = '投稿待ち'; if (imgOf(m)) a.img = imgOf(m); }
      else if (rx.name === 'sumi') tgt = '投稿済み';
      if (tgt && (a.target === null || RANK[tgt] > RANK[a.target])) a.target = tgt;
    }
  }
  console.log((APPLY ? 'APPLY' : 'DRY') + ' 対象タスク=' + Object.keys(agg).length + ' / 走査リアクション=' + stateKeys.length + '\n');
  let advanced = 0;
  for (const { task, target, kanpake, shusei, img } of Object.values(agg)) {
    const cur = task.properties['ステータス'].status?.name || '';
    const hasK = task.properties['完パケURL']?.url, hasS = task.properties['修正前URL']?.url, hasImg = (task.properties['サムネ']?.files || []).length;
    const props = {};
    const willAdvance = target && RANK[target] > (RANK[cur] ?? 0);
    if (willAdvance) props['ステータス'] = { status: { name: target } };
    if (kanpake && !hasK) props['完パケURL'] = { url: kanpake };
    if (shusei && !hasS) props['修正前URL'] = { url: shusei };
    let imgNote = '';
    if (img && !hasImg) imgNote = ' +サムネ(' + img.name + ')';
    if (!Object.keys(props).length && !imgNote) continue;
    console.log((willAdvance ? '前進' : '補完') + ': ' + nm(task).slice(0, 24) + ' [' + cur + (willAdvance ? '→' + target : '') + ']' + (props['完パケURL'] ? ' +完パケ' : '') + (props['修正前URL'] ? ' +修正前' : '') + imgNote);
    if (APPLY) {
      if (img && !hasImg) { try { const up = await upImg(img); props['サムネ'] = { files: [{ type: 'file_upload', file_upload: { id: up.id }, name: up.name }] }; } catch (e) { console.log('  サムネ失敗:' + e.message); } }
      if (Object.keys(props).length) { await fetch('https://api.notion.com/v1/pages/' + task.id, { method: 'PATCH', headers: NHJ, body: JSON.stringify({ properties: props }) }); advanced++; }
    }
  }
  console.log('\n' + (APPLY ? '適用' : '(dry)') + ' 変更タスク=' + advanced);
  if (APPLY) { const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}; const now = new Date().toISOString(); for (const k of stateKeys) st[k] = now; writeFileSync(STATE, JSON.stringify(st, null, 0)); console.log('state seeded: ' + Object.keys(st).length + '件（以降のcronは再処理しない）'); }
}
main().catch(e => { console.error(e); process.exit(1); });
