// SKAI 캠페인 맵 v3 — 노션 → HTML 진척도 자동 동기화
// GitHub Actions cron으로 매일 09:00 + 15:00 KST 실행
//
// 노션 "마일스톤 타임라인" DB에서 "6. 마케팅 - 인텔리전스" 프로젝트 항목을 가져와
// index.html의 .progress-tracker .pt-bar 영역을 교체 + commit.

import fs from 'node:fs';
import path from 'node:path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('[ERROR] NOTION_TOKEN env not set');
  process.exit(1);
}

// "마일스톤 타임라인" 데이터베이스 ID
const NOTION_DB_ID = '1455fe38fd4742eb9ea1c2b20a5a461d';
const TARGET_PROJECT = '6. 마케팅 - 인텔리전스';
const HTML_PATH = path.resolve('index.html');

// 노션 상태값 → HTML 클래스 매핑
const STATUS_TO_CLASS = {
  '완료':       'done',
  '진행중':     'ing',
  '이번 주':    'ing',
  '예정':       'plan',
  '확정 마감':  'plan',
  '대기':       'plan',
};

// 라벨 단축 (긴 마일스톤 → 14자 이내)
function shortLabel(title) {
  if (!title) return '미정';
  const cleaned = title.trim().replace(/^[-•·\s]+/, '').trim();
  // ":", "-", "|" 기준 마지막 부분 우선 (예: "마케팅 : 에이토즈" → "에이토즈")
  const parts = cleaned.split(/[:\-|]/).map(s => s.trim()).filter(Boolean);
  let label = parts.length > 1 ? parts[parts.length - 1] : cleaned;
  // "( )" 안 내용 제거
  label = label.replace(/\([^)]*\)/g, '').trim();
  return label.length > 14 ? label.slice(0, 13) + '…' : label;
}

// 날짜 범위 포맷 (5/22 또는 5/22~5/29)
function formatDateRange(start, end) {
  if (!start) return '';
  const fmt = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  if (!end || end === start) return fmt(start);
  return `${fmt(start)}~${fmt(end)}`;
}

// HTML escape
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 오늘 KST 날짜 YYYY-MM-DD
function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// 노션 DB query (pagination 포함)
async function queryNotionDB() {
  const results = [];
  let nextCursor;
  let pageCount = 0;

  do {
    const body = {
      filter: {
        property: '프로젝트',
        select: { equals: TARGET_PROJECT },
      },
      sorts: [{ property: '시작일', direction: 'ascending' }],
      page_size: 100,
    };
    if (nextCursor) body.start_cursor = nextCursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API ${res.status}: ${text}`);
    }

    const data = await res.json();
    results.push(...data.results);
    nextCursor = data.next_cursor;
    pageCount += 1;
  } while (nextCursor);

  console.log(`[notion] fetched ${results.length} pages (${pageCount} request${pageCount > 1 ? 's' : ''})`);
  return results;
}

// 노션 page → HTML pt-item 변환
function pagesToItems(pages) {
  return pages.map(page => {
    const props = page.properties;
    const title = props['마일스톤']?.title?.[0]?.plain_text || '';
    const status = props['상태']?.select?.name || '예정';
    const startDate = props['시작일']?.date?.start || '';
    const endDate = props['시작일']?.date?.end || '';

    const statusClass = STATUS_TO_CLASS[status] || 'plan';
    const dateRange = formatDateRange(startDate, endDate);
    const tooltip = [title.trim().replace(/^[-•·\s]+/, '').trim(), dateRange, status].filter(Boolean).join(' · ');

    return {
      label: shortLabel(title),
      tooltip,
      statusClass,
      status,
      startDate,
    };
  });
}

// pt-bar HTML 블록 생성
function buildBarHTML(items) {
  return items.map(it =>
    `    <div class="pt-item pt-item--${it.statusClass}" title="${esc(it.tooltip)}"><span class="pt-dot"></span>${esc(it.label)}</div>`
  ).join('\n');
}

// 카운트 집계
function countItems(items) {
  return items.reduce((acc, it) => {
    acc[it.statusClass] = (acc[it.statusClass] || 0) + 1;
    return acc;
  }, { done: 0, ing: 0, plan: 0 });
}

// HTML 진척도 영역 업데이트
function updateHTML(html, items, counts, total, dateStr) {
  // 1) pt-counts 배지 업데이트
  html = html.replace(
    /<span class="pt-count pt-done-badge">완료 \d+<\/span>/,
    `<span class="pt-count pt-done-badge">완료 ${counts.done}</span>`
  );
  html = html.replace(
    /<span class="pt-count pt-ing-badge">진행중 \d+<\/span>/,
    `<span class="pt-count pt-ing-badge">진행중 ${counts.ing}</span>`
  );
  html = html.replace(
    /<span class="pt-count pt-plan-badge">예정 \d+<\/span>/,
    `<span class="pt-count pt-plan-badge">예정 ${counts.plan}</span>`
  );

  // 2) pt-total 문구 업데이트
  html = html.replace(
    /<span class="pt-total">[^<]*<\/span>/,
    `<span class="pt-total">총 ${total}개 항목 · 기준일 ${dateStr} (노션 자동 동기화)</span>`
  );

  // 3) pt-bar 내부 교체 (.pt-bar 시작 ~ </div> 까지)
  const newBar = buildBarHTML(items);
  html = html.replace(
    /(<div class="pt-bar">)[\s\S]*?(\n  <\/div>)/,
    `$1\n${newBar}$2`
  );

  return html;
}

// 메인 실행
(async () => {
  try {
    console.log(`[start] ${new Date().toISOString()}`);
    const pages = await queryNotionDB();
    const items = pagesToItems(pages);
    const counts = countItems(items);
    const total = items.length;
    const dateStr = todayKST();

    console.log(`[items] total=${total}, done=${counts.done}, ing=${counts.ing}, plan=${counts.plan}`);

    if (total < 20) {
      console.warn(`[WARN] item count ${total} unexpectedly low — possible API issue`);
    }

    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const updated = updateHTML(html, items, counts, total, dateStr);

    if (html === updated) {
      console.log('[done] no HTML changes (already in sync)');
    } else {
      fs.writeFileSync(HTML_PATH, updated, 'utf8');
      console.log(`[done] index.html updated (${dateStr})`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message || err);
    process.exit(1);
  }
})();
