// 玩法说明 (How to play): viewer for the 19 official tutorial pages of the mode (local-client art, DESIGN §13:
// data/local-assets.json → guide/autochess_{home 1–9, shop 1–6, handbook 1–4}). The pages are stored squashed to
// 1024² and are displayed stretched back to 16:9. Three chapters (基础规则 / 调度手册 / 进阶图鉴), ‹ › buttons,
// ←/→ (A/D) keys, page dots, thumbnails; Esc or the backdrop closes. Adjacent pages are preloaded.
// Without the local art the viewer shows the official loading-screen tips (config.tips) instead.
//
// Global & imperative so every screen can open it: `openGuide(page?)`; <GuideHost/> is mounted once by main.js
// (and by the dev mock harness); <GuideButton/> is the standard trigger (title, lobby, room, in-match menu).

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, MicroLabel, Button, Spinner } from './components.js';
import { createStore, useStore } from '../store.js';
import { data, useData, localAsset } from '../data.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Page catalogue in reading order (titles transcribed from the pages). */
export const GUIDE_CHAPTERS = [
  { id: 'home', name: '基础规则', micro: 'BASICS', pages: [
    ['autochess_home_1', '卫戍协议已运行'], ['autochess_home_2', '攻防战'], ['autochess_home_3', '休整期 · 区域'],
    ['autochess_home_4', '休整期 · 资金与调度'], ['autochess_home_5', '机变阶段'], ['autochess_home_6', '限时战斗'],
    ['autochess_home_7', '作战期'], ['autochess_home_8', '协同战斗'], ['autochess_home_9', '盟约'],
  ] },
  { id: 'shop', name: '调度手册', micro: 'HANDBOOK', pages: [
    ['autochess_shop_1', '调度手册'], ['autochess_shop_2', '干员晋级'], ['autochess_shop_3', '加成情况'],
    ['autochess_shop_4', '卫戍能力'], ['autochess_shop_5', '盟约'], ['autochess_shop_6', '助战及自选编队'],
  ] },
  { id: 'handbook', name: '进阶图鉴', micro: 'ADVANCED', pages: [
    ['autochess_handbook_1', '敌人类型'], ['autochess_handbook_2', '盟约激活与叠加'], ['autochess_handbook_3', '追加盟约'],
    ['autochess_handbook_4', '策略与轮选'],
  ] },
];

/**
 * Flat page list with URLs (only pages the local manifest lists).
 * @returns {Array<{ key: string, title: string, chapter: number, url: string }>}
 */
export function guidePages() {
  const out = [];
  GUIDE_CHAPTERS.forEach((ch, ci) => {
    for (const [key, title] of ch.pages) {
      const url = localAsset('guide', key);
      if (url) out.push({ key, title, chapter: ci, url });
    }
  });
  return out;
}

/** Open/closed + current page. */
export const guideStore = createStore({ open: false, page: 0 });

/** Open the viewer (optionally at a page index). */
export function openGuide(page = 0) {
  data.load('local');
  data.load('config');
  guideStore.set({ open: true, page: Math.max(0, page | 0) });
}
export const closeGuide = () => guideStore.set({ open: false });

/** Standard 玩法说明 trigger button. */
export function GuideButton({ class: cls, size = 'sm', variant = 'ghost', label = '玩法说明', square = false }) {
  return html`<${Button} variant=${variant} size=${size} icon="book" square=${square} class=${cx('guide-btn', cls)}
    onClick=${() => openGuide(0)} title="玩法说明" aria-label="玩法说明">${square ? null : label}<//>`;
}

function preload(url) {
  if (!url || typeof Image === 'undefined') return;
  const img = new Image();
  img.decoding = 'async';
  img.crossOrigin = 'anonymous';
  img.src = url;
}

/** Fallback body when the tutorial art is not installed: the official tips as a numbered list. */
function TipsFallback() {
  const tips = (Array.isArray(data.get('config')?.tips) ? data.get('config').tips : []).map((t) => t?.tip).filter(Boolean);
  return html`<div class="guide__tips">
    <${MicroLabel} tone="mint">TIPS // 模拟要点</${MicroLabel}>
    <ol>${tips.map((t, i) => html`<li key=${i}>${t}</li>`)}</ol>
    ${!tips.length ? html`<p class="t-lo">暂无说明内容</p>` : null}
  </div>`;
}

/** The viewer (mounted once near the root). */
export function GuideHost() {
  const { open, page } = useStore((s) => s, Object.is, guideStore);
  const ready = useData('local', 'config');
  const pages = useMemo(() => (ready ? guidePages() : []), [ready]);
  const [loaded, setLoaded] = useState(() => new Set());
  const [failed, setFailed] = useState(() => new Set());
  const boxRef = useRef(null);
  const n = pages.length;
  const i = n ? Math.min(Math.max(0, page), n - 1) : 0;
  const cur = pages[i] || null;
  const go = (k) => { if (n) guideStore.set({ open: true, page: ((k % n) + n) % n }); };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      let handled = true;
      if (k === 'Escape') closeGuide();
      else if (k === 'ArrowRight' || k === 'd' || k === 'D' || k === 'PageDown') go(guideStore.get().page + 1);
      else if (k === 'ArrowLeft' || k === 'a' || k === 'A' || k === 'PageUp') go(guideStore.get().page - 1);
      else if (k === 'Home') go(0);
      else if (k === 'End') go(n - 1);
      else handled = (!!k && k.length === 1) || k === ' '; // swallow game shortcuts (R/F/D/Space) while open
      if (handled) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => boxRef.current?.focus?.(), 30);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(t); };
  }, [open, n]);

  useEffect(() => {
    if (!open || !n) return;
    preload(pages[(i + 1) % n]?.url);
    preload(pages[(i + n - 1) % n]?.url);
  }, [open, i, n]);

  if (!open) return null;
  const chapter = cur ? GUIDE_CHAPTERS[cur.chapter] : null;
  const firstOf = (ci) => pages.findIndex((p) => p.chapter === ci);
  const isLoaded = cur && loaded.has(cur.url);
  return html`<div class="guide" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) closeGuide(); }}>
    <div class="guide__box brackets" role="dialog" aria-modal="true" aria-label="玩法说明" tabindex="-1" ref=${boxRef}>
      <header class="guide__head">
        <div class="guide__titles">
          <${MicroLabel} tone="mint">HOW TO PLAY // STRONGHOLD PROTOCOL</${MicroLabel}>
          <h2 class="guide__title">玩法说明</h2>
        </div>
        ${n ? html`<nav class="guide__chapters" aria-label="章节">
          ${GUIDE_CHAPTERS.map((ch, ci) => {
            const at = firstOf(ci);
            if (at < 0) return null;
            return html`<button key=${ch.id} type="button" class=${cx('guide__chapter', cur?.chapter === ci && 'is-on')} onClick=${() => go(at)}>
              <span class="guide__chname">${ch.name}</span><span class="guide__chmicro">${ch.micro}</span>
            </button>`;
          })}
        </nav>` : null}
        <button type="button" class="guide__close" aria-label="关闭" title="关闭 (Esc)" onClick=${closeGuide}><${Icon} name="close" /></button>
      </header>

      ${n ? html`<div class="guide__stage">
        <button type="button" class="guide__nav guide__prev" aria-label="上一页" onClick=${() => go(i - 1)}><${Icon} name="chevronLeft" /></button>
        <div class=${cx('guide__page', isLoaded && 'is-loaded')}>
          ${cur && !failed.has(cur.url) ? html`<img key=${cur.url} src=${cur.url} alt=${cur.title} draggable=${false}
            onLoad=${() => setLoaded((s) => new Set(s).add(cur.url))}
            onError=${() => setFailed((s) => new Set(s).add(cur.url))} />` : html`<div class="guide__missing"><${Icon} name="info" />该页面暂时无法显示</div>`}
          ${!isLoaded && cur && !failed.has(cur.url) ? html`<span class="guide__loading"><${Spinner} size="md" /></span>` : null}
        </div>
        <button type="button" class="guide__nav guide__next" aria-label="下一页" onClick=${() => go(i + 1)}><${Icon} name="chevronRight" /></button>
      </div>` : html`<div class="guide__stage guide__stage--text"><${TipsFallback} /></div>`}

      ${n ? html`<footer class="guide__foot">
        <div class="guide__label">
          <span class="guide__chtag">${chapter?.name || ''}</span>
          <b class="guide__ptitle">${cur?.title || ''}</b>
        </div>
        <div class="guide__dots" role="tablist" aria-label="页码">
          ${pages.map((p, k) => html`<button key=${p.key} type="button" role="tab" aria-selected=${k === i ? 'true' : 'false'} title=${p.title}
            class=${cx('guide__dot', k === i && 'is-on', k > 0 && pages[k - 1].chapter !== p.chapter && 'is-first')} onClick=${() => go(k)}></button>`)}
        </div>
        <span class="guide__count num">${i + 1} / ${n}</span>
      </footer>` : null}
    </div>
  </div>`;
}
