/* Ortak yardımcılar: iki panelde (personel ve yönetici) de kullanılır. */
window.AS = (function () {
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 });
const nn = new Intl.NumberFormat('tr-TR');
const fmt = (n) => nf.format(isFinite(n) ? n : 0);
const pct = (n) => (isFinite(n) ? n : 0).toFixed(1).replace('.', ',') + '%';
const trMap = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
const norm = (s) => String(s).toLocaleLowerCase('tr').replace(/[çğıöşüâîû]/g, (c) => trMap[c]).replace(/[^a-z0-9]/g, '');
const low = (s) => String(s == null ? '' : s).toLocaleLowerCase('tr');
const tarihSaat = (iso) => iso ? new Date(iso).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
const tarih = (iso) => {
  if (!iso) return '-';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
};
const pad = (n) => String(n).padStart(2, '0');
const bugun = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

function parseNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  let s = String(v == null ? '' : v).trim().replace(/[^\d,.\-]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  return parseFloat(s);
}

let toastT;
function toast(msg, tip) {
  const t = $('#toast'); t.textContent = msg; t.className = tip || ''; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3600);
}

const TUR = { kurulum: 'Kurulum', filtre: 'Filtre değişimi', servis: 'Servis / arıza', teslimat: 'Teslimat', diger: 'Diğer' };
const MASRAF = { malzeme: 'Malzeme', yol: 'Yol / yakıt', iscilik: 'İşçilik', diger: 'Diğer' };
const DURUM = { bekliyor: ['Bekliyor', 'neutral'], devam: ['Devam ediyor', 'info'], tamam: ['Tamamlandı', 'good'], iptal: ['İptal', 'bad'] };
const durumPill = (d) => { const x = DURUM[d] || [d, 'neutral']; return `<span class="pill ${x[1]}">${x[0]}</span>`; };
const oncelikPill = (o) => o === 'acil' ? '<span class="pill bad">Acil</span>' : '';
const acikMi = (j) => j.durum === 'bekliyor' || j.durum === 'devam';
const gecikmis = (j) => Boolean(j.termin) && acikMi(j) && j.termin < bugun();
const terminPill = (j) => !j.termin ? '' : gecikmis(j)
  ? `<span class="pill bad">Gecikmiş · ${tarih(j.termin)}</span>`
  : `<span class="pill neutral">Termin ${tarih(j.termin)}</span>`;
const secenek = (obj, secili) => Object.keys(obj).map((k) => `<option value="${k}"${k === secili ? ' selected' : ''}>${esc(obj[k])}</option>`).join('');

/* ---------- API istemcisi ---------- */
function createApi(anahtar, yetkisiz) {
  let T = null;
  try { T = localStorage.getItem(anahtar); } catch (e) { /* depolama kapalı olabilir */ }
  async function api(yol, o) {
    o = o || {};
    const r = await fetch('/api/' + yol, {
      method: o.method || 'GET',
      headers: Object.assign({ 'content-type': 'application/json' }, T ? { authorization: 'Bearer ' + T } : {}),
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined
    });
    let d = null; try { d = await r.json(); } catch (e) { /* gövde yok */ }
    if (r.status === 401 && yol !== 'login') {
      api.token(null);
      if (yetkisiz) yetkisiz();
      throw new Error('Oturum süresi doldu, yeniden giriş yapın');
    }
    if (!r.ok) { const e = new Error((d && d.hata) || ('İstek başarısız (' + r.status + ')')); e.status = r.status; throw e; }
    return d;
  }
  api.token = function (v) {
    if (v === undefined) return T;
    T = v;
    try { if (v) localStorage.setItem(anahtar, v); else localStorage.removeItem(anahtar); } catch (e) { /* yoksay */ }
    return T;
  };
  return api;
}

/* ---------- Barkodlu satış modülü (#p-satis içindeki sabit HTML'e bağlanır) ---------- */
function satisModulu(opt) {
  const root = $('#p-satis');
  let mod = 'perakende';
  let sepet = [];
  const urunler = () => opt.urunler();
  const bul = (b) => urunler().find((u) => u.barkod === b);
  const fiyat = (u) => mod === 'toptan' ? u.toptan : u.perakende;

  function oneriAra(q) {
    const s = low(q.trim()); if (!s) return [];
    return urunler().filter((u) => u.barkod.includes(s) || low(u.ad).includes(s)).slice(0, 6);
  }
  function ekle(b) {
    const u = bul(b); if (!u) return false;
    const s = sepet.find((x) => x.barkod === b);
    const yeni = (s ? s.adet : 0) + 1;
    if (yeni > u.stok) { toast(`${u.ad}: stokta yalnızca ${u.stok} adet var`, 'bad'); return false; }
    if (s) s.adet = yeni; else sepet.push({ barkod: b, adet: 1 });
    render(); return true;
  }
  function render() {
    $$('#p-satis .seg [data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mod)));
    const satirlar = sepet.map((s) => ({ s, u: bul(s.barkod) })).filter((x) => x.u);
    $('#sepetBody').innerHTML = satirlar.length ? satirlar.map((x) => {
      const f = fiyat(x.u), bk = esc(x.u.barkod);
      return `<tr><td>${esc(x.u.ad)}<div class="mono muted">${bk}</div></td><td class="num">${fmt(f)}</td>` +
        `<td class="num"><span class="qty"><button class="btn icon" data-act="azalt" data-b="${bk}" aria-label="Azalt">−</button>` +
        `<input type="number" min="1" max="${x.u.stok}" value="${x.s.adet}" data-qty="${bk}" aria-label="Adet">` +
        `<button class="btn icon" data-act="arttir" data-b="${bk}" aria-label="Artır">+</button></span></td>` +
        `<td class="num"><strong>${fmt(f * x.s.adet)}</strong></td>` +
        `<td class="num"><button class="btn sm" data-act="sil" data-b="${bk}">Kaldır</button></td></tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">Sepet boş. Bir barkod okutun.</td></tr>';
    const ciro = satirlar.reduce((a, x) => a + fiyat(x.u) * x.s.adet, 0);
    let h = `<div><span class="muted">Ürün adedi</span><span>${nn.format(satirlar.reduce((a, x) => a + x.s.adet, 0))}</span></div>`;
    if (opt.yonetici()) {
      const mal = satirlar.reduce((a, x) => a + x.u.alis * x.s.adet, 0), kar = ciro - mal;
      h += `<div><span class="muted">Alış maliyeti</span><span>${fmt(mal)}</span></div><div><span class="muted">Brüt kâr</span><span class="${kar < 0 ? 'neg' : 'pos'}">${fmt(kar)}</span></div>`;
    }
    $('#sepetOzet').innerHTML = h + `<div class="big"><span>Toplam</span><span>${fmt(ciro)}</span></div>`;
  }
  async function son() {
    $('#sonBaslik').textContent = opt.yonetici() ? 'Son satışlar' : 'Son satışlarım';
    try {
      const l = await opt.api('sales?limit=6');
      $('#sonSatis').innerHTML = l.length ? l.map((s) =>
        `<li><span>${tarihSaat(s.t)}${s.musteri ? ' · ' + esc(s.musteri) : ''}<br><span class="muted">${s.mod === 'toptan' ? 'Toptan' : 'Perakende'}${opt.yonetici() && s.user ? ' · ' + esc(s.user.name) : ''}</span></span><strong>${fmt(s.ciro)}</strong></li>`
      ).join('') : '<li class="muted">Henüz satış yok.</li>';
    } catch (e) { $('#sonSatis').innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
  }
  async function tamamla() {
    if (!sepet.length) { toast('Sepet boş', 'bad'); return; }
    const b = $('#satisBtn'); b.disabled = true;
    try {
      const d = await opt.api('sales', { method: 'POST', body: { mod, musteri: $('#musteri').value.trim(), satirlar: sepet.map((s) => ({ barkod: s.barkod, adet: s.adet })) } });
      opt.urunGuncelle(d.urunler);
      sepet = []; $('#musteri').value = '';
      render(); son();
      toast(opt.yonetici() ? `Satış kaydedildi: ${fmt(d.satis.ciro)} · kâr ${fmt(d.satis.ciro - d.satis.maliyet)}` : `Satış kaydedildi: ${fmt(d.satis.ciro)}`);
      $('#barkod').focus();
    } catch (e) {
      toast(e.message, 'bad');
      try { await opt.yenile(); } catch (x) { /* yoksay */ }
      render();
    }
    b.disabled = false;
  }

  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act, b = a.dataset.b;
    if (act === 'mod') { mod = a.dataset.m; render(); $('#barkod').focus(); }
    else if (act === 'sepet-ekle') { ekle(b); $('#barkod').value = ''; $('#oneri').hidden = true; $('#barkod').focus(); }
    else if (act === 'arttir') ekle(b);
    else if (act === 'azalt') { const s = sepet.find((x) => x.barkod === b); if (s) { s.adet--; if (s.adet < 1) sepet = sepet.filter((x) => x !== s); render(); } }
    else if (act === 'sil') { sepet = sepet.filter((x) => x.barkod !== b); render(); }
    else if (act === 'satis-tamam') tamamla();
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'barkod') {
      const l = t.value.trim().length >= 2 ? oneriAra(t.value) : [], o = $('#oneri');
      o.hidden = !l.length;
      o.innerHTML = l.map((u) => `<button type="button" data-act="sepet-ekle" data-b="${esc(u.barkod)}"><span>${esc(u.ad)}</span><span class="mono muted">${esc(u.barkod)} · stok ${u.stok}</span></button>`).join('');
    } else if (t.dataset.qty) {
      const u = bul(t.dataset.qty), s = sepet.find((x) => x.barkod === t.dataset.qty), v = Math.round(parseNum(t.value));
      if (u && s && v >= 1) {
        if (v > u.stok) { toast(`${u.ad}: stokta yalnızca ${u.stok} adet var`, 'bad'); s.adet = u.stok; } else s.adet = v;
        render();
      }
    }
  });
  $('#barkod').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = e.target.value.trim(); if (!v) return;
    if (bul(v)) { ekle(v); e.target.value = ''; $('#oneri').hidden = true; return; }
    const m = oneriAra(v);
    if (m.length === 1) { ekle(m[0].barkod); e.target.value = ''; $('#oneri').hidden = true; }
    else if (m.length > 1) toast('Birden fazla ürün eşleşti. Listeden seçin.');
    else { toast('Barkod bulunamadı: ' + v, 'bad'); e.target.select(); }
  });

  return { render() { render(); son(); }, sifirla() { sepet = []; } };
}

return {
  $, $$, esc, fmt, nn, pct, norm, low, tarihSaat, tarih, bugun, parseNum, toast,
  TUR, MASRAF, durumPill, oncelikPill, terminPill, acikMi, gecikmis, secenek,
  createApi, satisModulu
};
})();
